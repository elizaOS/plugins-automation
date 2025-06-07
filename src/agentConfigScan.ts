import { Octokit } from "@octokit/rest";
import OpenAI from "openai";
import process from "process";
import dotenv from "dotenv";
import fs from "fs-extra";
import path from "path";
import { execSync } from "child_process";
import chalk from "chalk";
import ora from "ora";

dotenv.config();

interface EnvVariable {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  defaultValue?: string;
}

interface AgentConfig {
  pluginType: string;
  pluginParameters: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
      default?: string;
    }
  >;
}

class AgentConfigScanner {
  private octokit: Octokit;
  private openai: OpenAI;
  private org = "elizaos-plugins";
  private tempDir = "./temp-repos";
  private readonly TEST_MODE = true; // Set to true to process only 1 repository for testing

  constructor() {
    const githubToken = process.env.GITHUB_TOKEN;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!githubToken) {
      console.error(
        chalk.red("Error: GITHUB_TOKEN environment variable is not set")
      );
      process.exit(1);
    }

    if (!openaiApiKey) {
      console.error(
        chalk.red("Error: OPENAI_API_KEY environment variable is not set")
      );
      process.exit(1);
    }

    this.octokit = new Octokit({ auth: githubToken });
    this.openai = new OpenAI({ apiKey: openaiApiKey });
  }

  async getRepositories(): Promise<string[]> {
    const spinner = ora(
      "Fetching repositories from elizaos-plugins org..."
    ).start();
    try {
      const repos = await this.octokit.paginate(
        this.octokit.rest.repos.listForOrg,
        {
          org: this.org,
          per_page: 100,
        }
      );

      const repoNames = repos.map((repo) => repo.name);
      spinner.succeed(`Found ${repoNames.length} repositories`);
      return repoNames;
    } catch (error) {
      spinner.fail("Failed to fetch repositories");
      throw error;
    }
  }

  async checkFor1xBranch(repoName: string): Promise<boolean> {
    try {
      const branches = await this.octokit.rest.repos.listBranches({
        owner: this.org,
        repo: repoName,
      });

      return branches.data.some(
        (branch) =>
          branch.name.startsWith("1.") ||
          branch.name === "1.x" ||
          branch.name === "v1"
      );
    } catch (error) {
      console.warn(
        chalk.yellow(`Warning: Could not check branches for ${repoName}`)
      );
      return false;
    }
  }

  async cloneRepository(repoName: string, branch?: string): Promise<string> {
    const repoPath = path.join(this.tempDir, repoName);

    // Clean up existing directory
    if (await fs.pathExists(repoPath)) {
      await fs.remove(repoPath);
    }

    await fs.ensureDir(this.tempDir);

    const cloneUrl = `https://github.com/${this.org}/${repoName}.git`;
    const branchFlag = branch ? `-b ${branch}` : "";

    try {
      execSync(`git clone ${branchFlag} ${cloneUrl} ${repoPath}`, {
        stdio: "pipe",
      });
      return repoPath;
    } catch (error) {
      throw new Error(`Failed to clone ${repoName}: ${error}`);
    }
  }

  async scanFilesForEnvVars(repoPath: string): Promise<string[]> {
    const files: string[] = [];
    const extensions = [".ts", ".js", ".tsx", ".jsx", ".md", ".json"];

    async function walkDir(dir: string) {
      const items = await fs.readdir(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules and other common directories
          if (
            !["node_modules", ".git", "dist", "build", ".next"].includes(item)
          ) {
            await walkDir(fullPath);
          }
        } else if (extensions.some((ext) => item.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    }

    await walkDir(repoPath);
    return files;
  }

  async analyzeFileWithLLM(filePath: string): Promise<EnvVariable[]> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const fileName = path.basename(filePath);

      // Skip very large files
      if (content.length > 50000) {
        return [];
      }

      const prompt = `
Analyze this ${fileName} file and identify ALL environment variables that are used or referenced.
Look for patterns like:
- process.env.VARIABLE_NAME
- process.env["VARIABLE_NAME"]
- Environment variables mentioned in README files
- Configuration objects that reference env vars
- Default values or fallbacks for env vars

For each environment variable found, determine:
1. The variable name
2. The data type (string, number, boolean, etc.)
3. A description of what it's used for
4. Whether it's required or optional
5. Any default values

Return ONLY a JSON array of objects with this structure:
[
  {
    "name": "VARIABLE_NAME",
    "type": "string|number|boolean",
    "description": "What this variable is used for",
    "required": true|false,
    "defaultValue": "default value if any"
  }
]

File content:
\`\`\`
${content}
\`\`\`
`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              "You are an expert code analyzer. Extract environment variables from code and documentation files. Return only valid JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0,
        max_tokens: 2000,
      });

      const responseText = response.choices[0]?.message?.content?.trim();
      if (!responseText) return [];

      try {
        const variables = JSON.parse(responseText);
        return Array.isArray(variables) ? variables : [];
      } catch (parseError) {
        console.warn(
          chalk.yellow(`Failed to parse LLM response for ${fileName}`)
        );
        return [];
      }
    } catch (error) {
      console.warn(
        chalk.yellow(
          `Failed to analyze ${filePath}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        )
      );
      return [];
    }
  }

  async getCurrentAgentConfig(repoPath: string): Promise<AgentConfig | null> {
    const packageJsonPath = path.join(repoPath, "package.json");

    if (!(await fs.pathExists(packageJsonPath))) {
      return null;
    }

    try {
      const packageJson = await fs.readJson(packageJsonPath);
      return packageJson.agentConfig || null;
    } catch (error) {
      console.warn(chalk.yellow(`Failed to read package.json in ${repoPath}`));
      return null;
    }
  }

  async getCurrentPackageJson(repoPath: string): Promise<any | null> {
    const packageJsonPath = path.join(repoPath, "package.json");

    if (!(await fs.pathExists(packageJsonPath))) {
      return null;
    }

    try {
      return await fs.readJson(packageJsonPath);
    } catch (error) {
      console.warn(chalk.yellow(`Failed to read package.json in ${repoPath}`));
      return null;
    }
  }

  mergeEnvVariables(
    existing: AgentConfig | null,
    discovered: EnvVariable[]
  ): AgentConfig {
    const baseConfig: AgentConfig = {
      pluginType: "elizaos:plugin:1.0.0",
      pluginParameters: {},
    };

    // Start with existing config if available
    if (existing) {
      baseConfig.pluginType = existing.pluginType;
      baseConfig.pluginParameters = { ...existing.pluginParameters };
    }

    // Add discovered variables
    for (const envVar of discovered) {
      if (!baseConfig.pluginParameters[envVar.name]) {
        baseConfig.pluginParameters[envVar.name] = {
          type: envVar.type,
          description: envVar.description,
        };

        if (envVar.required !== undefined) {
          baseConfig.pluginParameters[envVar.name]!.required = envVar.required;
        }

        if (envVar.defaultValue) {
          baseConfig.pluginParameters[envVar.name]!.default =
            envVar.defaultValue;
        }
      }
    }

    return baseConfig;
  }

  async updatePackageJson(
    repoPath: string,
    agentConfig: AgentConfig
  ): Promise<boolean> {
    const packageJsonPath = path.join(repoPath, "package.json");

    if (!(await fs.pathExists(packageJsonPath))) {
      return false;
    }

    try {
      const packageJson = await fs.readJson(packageJsonPath);
      packageJson.agentConfig = agentConfig;

      // Bump patch version
      if (packageJson.version) {
        const version = packageJson.version;
        const versionParts = version.split(".");
        if (versionParts.length === 3) {
          const major = parseInt(versionParts[0]) || 0;
          const minor = parseInt(versionParts[1]) || 0;
          const patch = parseInt(versionParts[2]) || 0;
          packageJson.version = `${major}.${minor}.${patch + 1}`;
        }
      }

      await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
      return true;
    } catch (error) {
      console.warn(
        chalk.yellow(
          `Failed to update package.json in ${repoPath}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        )
      );
      return false;
    }
  }

  async updateReadme(repoPath: string, envVars: EnvVariable[]): Promise<void> {
    const readmePath = path.join(repoPath, "README.md");

    if (!(await fs.pathExists(readmePath)) || envVars.length === 0) {
      return;
    }

    try {
      let content = await fs.readFile(readmePath, "utf-8");

      // Generate environment variables section
      const envSection = this.generateEnvSection(envVars);

      // Look for existing environment section
      const envSectionRegex = /## Environment Variables[\s\S]*?(?=##|$)/;

      if (envSectionRegex.test(content)) {
        // Replace existing section
        content = content.replace(envSectionRegex, envSection);
      } else {
        // Add new section before installation or at the end
        const installationIndex = content
          .toLowerCase()
          .indexOf("## installation");
        if (installationIndex !== -1) {
          content =
            content.slice(0, installationIndex) +
            envSection +
            "\n\n" +
            content.slice(installationIndex);
        } else {
          content += "\n\n" + envSection;
        }
      }

      await fs.writeFile(readmePath, content);
    } catch (error) {
      console.warn(
        chalk.yellow(
          `Failed to update README in ${repoPath}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        )
      );
    }
  }

  generateEnvSection(envVars: EnvVariable[]): string {
    if (envVars.length === 0) return "";

    let section = "## Environment Variables\n\n";
    section +=
      "The following environment variables are required or optional for this plugin:\n\n";

    for (const envVar of envVars) {
      section += `### ${envVar.name}\n`;
      section += `- **Type**: ${envVar.type}\n`;
      section += `- **Description**: ${envVar.description}\n`;
      section += `- **Required**: ${envVar.required ? "Yes" : "No"}\n`;

      if (envVar.defaultValue) {
        section += `- **Default**: \`${envVar.defaultValue}\`\n`;
      }

      section += "\n";
    }

    return section;
  }

  async commitChanges(repoPath: string, repoName: string): Promise<boolean> {
    try {
      const cwd = repoPath;

      // Configure git user (use environment variables if available)
      const gitUser = process.env.GIT_USER_NAME || "Agent Config Scanner";
      const gitEmail = process.env.GIT_USER_EMAIL || "bot@elizaos.ai";

      execSync(`git config user.name "${gitUser}"`, { cwd, stdio: "pipe" });
      execSync(`git config user.email "${gitEmail}"`, { cwd, stdio: "pipe" });

      // Check if there are changes
      const status = execSync("git status --porcelain", {
        cwd,
        encoding: "utf-8",
      });
      if (!status.trim()) {
        return false; // No changes
      }

      // Stage and commit changes
      execSync("git add package.json README.md", { cwd, stdio: "pipe" });
      execSync(
        'git commit -m "chore: update agentConfig, environment variables documentation, and bump version"',
        { cwd, stdio: "pipe" }
      );

      // Push changes
      execSync("git push origin HEAD", { cwd, stdio: "pipe" });

      return true;
    } catch (error) {
      console.warn(
        chalk.yellow(
          `Failed to commit changes for ${repoName}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        )
      );
      return false;
    }
  }

  async processRepository(repoName: string): Promise<void> {
    const spinner = ora(`Processing ${repoName}...`).start();

    try {
      // Check for 1.x branch
      const has1xBranch = await this.checkFor1xBranch(repoName);
      const branchToUse = has1xBranch ? "1.x" : undefined;

      if (has1xBranch) {
        spinner.text = `Processing ${repoName} (1.x branch)...`;
      }

      // Clone repository
      const repoPath = await this.cloneRepository(repoName, branchToUse);

      // Get current agentConfig
      const currentConfig = await this.getCurrentAgentConfig(repoPath);

      // Scan files for environment variables
      const files = await this.scanFilesForEnvVars(repoPath);

      const allEnvVars: EnvVariable[] = [];

      // Analyze files with LLM (in batches to avoid rate limits)
      for (let i = 0; i < files.length; i += 5) {
        const batch = files.slice(i, i + 5);
        const batchPromises = batch.map((file) =>
          this.analyzeFileWithLLM(file)
        );
        const batchResults = await Promise.all(batchPromises);

        for (const result of batchResults) {
          allEnvVars.push(...result);
        }

        // Small delay to respect rate limits
        if (i + 5 < files.length) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      // Remove duplicates
      const uniqueEnvVars = allEnvVars.filter(
        (envVar, index, self) =>
          index === self.findIndex((e) => e.name === envVar.name)
      );

      if (uniqueEnvVars.length === 0) {
        spinner.succeed(`${repoName}: No environment variables found`);
        await fs.remove(repoPath);
        return;
      }

      // Merge with existing config
      const updatedConfig = this.mergeEnvVariables(
        currentConfig,
        uniqueEnvVars
      );

      // Get version info before update
      const oldPackageJson = await this.getCurrentPackageJson(repoPath);
      const oldVersion = oldPackageJson?.version || "unknown";

      // Update package.json
      const packageUpdated = await this.updatePackageJson(
        repoPath,
        updatedConfig
      );

      // Get new version info
      const newPackageJson = await this.getCurrentPackageJson(repoPath);
      const newVersion = newPackageJson?.version || "unknown";

      // Update README
      await this.updateReadme(repoPath, uniqueEnvVars);

      // Commit changes
      const committed = await this.commitChanges(repoPath, repoName);

      const envVarNames = uniqueEnvVars.map((v) => v.name).join(", ");
      const versionInfo =
        oldVersion !== newVersion ? ` (${oldVersion} → ${newVersion})` : "";

      if (committed) {
        spinner.succeed(
          `${repoName}: Updated and committed (${envVarNames})${versionInfo}`
        );
      } else if (packageUpdated) {
        spinner.succeed(
          `${repoName}: Updated but no changes to commit (${envVarNames})${versionInfo}`
        );
      } else {
        spinner.warn(
          `${repoName}: Found env vars but couldn't update (${envVarNames})`
        );
      }

      // Cleanup
      await fs.remove(repoPath);
    } catch (error) {
      spinner.fail(
        `${repoName}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );

      // Cleanup on error
      const repoPath = path.join(this.tempDir, repoName);
      if (await fs.pathExists(repoPath)) {
        await fs.remove(repoPath);
      }
    }
  }

  async run(): Promise<void> {
    console.log(chalk.blue("🔍 Agent Config Scanner"));
    console.log(
      chalk.gray(
        "Scanning elizaos-plugins repositories for environment variables...\n"
      )
    );

    try {
      // Ensure temp directory is clean
      if (await fs.pathExists(this.tempDir)) {
        await fs.remove(this.tempDir);
      }

      // Get all repositories
      const repositories = await this.getRepositories();

      // Apply test mode if enabled
      const reposToProcess = this.TEST_MODE ? repositories.slice(0, 1) : repositories;
      
      if (this.TEST_MODE) {
        console.log(chalk.yellow("🧪 TEST MODE: Processing only 1 repository\n"));
      }

      console.log(
        chalk.gray(`Processing ${reposToProcess.length} repositories...\n`)
      );

      // Process repositories one by one to avoid overwhelming the APIs
      for (const repo of reposToProcess) {
        await this.processRepository(repo);

        // Small delay between repositories
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      console.log(chalk.green("\n✅ Scan completed!"));
    } catch (error) {
      console.error(chalk.red("Fatal error:"), error);
      process.exit(1);
    } finally {
      // Final cleanup
      if (await fs.pathExists(this.tempDir)) {
        await fs.remove(this.tempDir);
      }
    }
  }
}

async function main(): Promise<void> {
  const scanner = new AgentConfigScanner();
  await scanner.run();
}

main().catch((error) => {
  console.error(chalk.red("Unhandled error:"), error);
  process.exit(1);
});
