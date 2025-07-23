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
  sensitive?: boolean;
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
      sensitive?: boolean;
    }
  >;
}

class AgentConfigScanner {
  private octokit: Octokit;
  private openai: OpenAI;
  private org = "elizaos-plugins";
  private tempDir = "./temp-repos";
  private readonly TEST_MODE = false; // Set to true to process only 1 repository for testing
  private readonly TARGET_REPO = ""; // Set to a specific repo name to target only that repo (e.g., "plugin-farcaster")

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

  async get1xBranchName(repoName: string): Promise<string | null> {
    try {
      const branches = await this.octokit.rest.repos.listBranches({
        owner: this.org,
        repo: repoName,
      });

      const branch1x = branches.data.find((branch) => branch.name === "1.x");

      return branch1x ? branch1x.name : null;
    } catch (error) {
      console.warn(
        chalk.yellow(`Warning: Could not check branches for ${repoName}`)
      );
      return null;
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
    const extensions = [".ts", ".js", ".tsx", ".jsx"];

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

  async analyzeFileWithLLM(
    filePath: string,
    existingConfig?: AgentConfig
  ): Promise<EnvVariable[]> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const fileName = path.basename(filePath);
      const relativePath = path.relative(process.cwd(), filePath);
      
      console.log(chalk.dim(`    🔍 Analyzing: ${relativePath}`));

      // Skip very large files
      if (content.length > 50000) {
        return [];
      }

      // Include existing config context for reference only
      const existingVarsContext = existingConfig?.pluginParameters
        ? `\n\nEXISTING CONFIGURATION REFERENCE:\nThe package.json currently has these environment variables configured:\n${JSON.stringify(
            existingConfig.pluginParameters,
            null,
            2
          )}\n\nIMPORTANT: Return ALL environment variables found in the code, regardless of whether they exist in the current configuration. The existing configuration is just for reference.`
        : "";

      const prompt = `
Analyze this ${fileName} file and identify ALL environment variables that are used or referenced.

CRITICAL: Find and return EVERY environment variable used in this code, even if you think it might be configured elsewhere.

Look for patterns like:
- process.env.VARIABLE_NAME
- process.env["VARIABLE_NAME"]
- runtime.getSetting('VARIABLE_NAME')
- runtime.getSetting("VARIABLE_NAME")
- getSetting('VARIABLE_NAME') or getSetting("VARIABLE_NAME")
- settings.VARIABLE_NAME
- config.VARIABLE_NAME
- Environment variables in import statements or constants
- Variables used in conditionals like "if (process.env.X)"
- Variables in template strings like \`\${process.env.X}\`
- Configuration objects that reference env vars
- Default values or fallbacks for env vars
- Variables mentioned in comments or documentation

For each environment variable found, determine:
1. The variable name (extract from process.env.X, runtime.getSetting('X'), getSetting('X'), etc.)
2. The data type (string, number, boolean, etc.)
3. A description of what it's used for based on the code context
4. Whether it's required or optional (look for error handling, default values, or conditional usage)
5. Any default values (from fallback assignments, ternary operators, or || operators)
6. Whether it's sensitive/secret data (API keys, passwords, tokens, private keys, secrets, credentials, etc.)

Note: runtime.getSetting() and getSetting() are common patterns for accessing environment variables in plugins.${existingVarsContext}

IMPORTANT: You must return ONLY a valid JSON array. Do not include any explanation or markdown. If no environment variables are found, return an empty array: []

Required JSON format:
[
  {
    "name": "VARIABLE_NAME",
    "type": "string|number|boolean",
    "description": "What this variable is used for",
    "required": true|false,
    "defaultValue": "default value if any",
    "sensitive": true|false
  }
]

File content:
\`\`\`
${content}
\`\`\`
`;

      const response = await this.openai.chat.completions.create({
        model: "o3",
        messages: [
          {
            role: "user",
            content: `You are an expert code analyzer. Extract environment variables from code and documentation files. Return only valid JSON.\n\n${prompt}`,
          },
        ],
        max_completion_tokens: 4000,
      });

      const responseText = response.choices[0]?.message?.content?.trim();
      if (!responseText) return [];

      try {
        // Try to extract JSON from the response if it's wrapped in markdown or text
        let jsonText = responseText;

        // Look for JSON array in the response
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }

        const variables = JSON.parse(jsonText);
        return Array.isArray(variables) ? variables : [];
      } catch (parseError) {
        // If parsing fails, try to find empty array response
        if (
          responseText.toLowerCase().includes("no environment variables") ||
          responseText.toLowerCase().includes("[]") ||
          responseText.trim() === "[]"
        ) {
          return [];
        }

        console.warn(
          chalk.yellow(
            `Failed to parse LLM response for ${fileName}: ${responseText.substring(
              0,
              100
            )}...`
          )
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
      pluginType: existing?.pluginType || "elizaos:plugin:1.0.0",
      pluginParameters: {},
    };

    // Track changes for logging
    const existingVars = new Set(Object.keys(existing?.pluginParameters || {}));
    const discoveredVars = new Set(discovered.map(v => v.name));
    const removedVars = [...existingVars].filter(v => !discoveredVars.has(v));
    const addedVars = [...discoveredVars].filter(v => !existingVars.has(v));
    const updatedVars: string[] = [];

    // Build fresh config from discovered variables only
    // This will update existing entries and remove unused ones
    for (const envVar of discovered) {
      // Check if this is an update to an existing variable
      const existingVar = existing?.pluginParameters?.[envVar.name];
      if (existingVar) {
        const hasChanges = 
          existingVar.type !== envVar.type ||
          existingVar.description !== envVar.description ||
          existingVar.required !== envVar.required ||
          existingVar.default !== envVar.defaultValue ||
          existingVar.sensitive !== envVar.sensitive;
        
        if (hasChanges) {
          updatedVars.push(envVar.name);
        }
      }

      baseConfig.pluginParameters[envVar.name] = {
        type: envVar.type,
        description: envVar.description,
      };

      if (envVar.required !== undefined) {
        baseConfig.pluginParameters[envVar.name]!.required = envVar.required;
      }

      if (envVar.defaultValue) {
        baseConfig.pluginParameters[envVar.name]!.default = envVar.defaultValue;
      }

      if (envVar.sensitive !== undefined) {
        baseConfig.pluginParameters[envVar.name]!.sensitive = envVar.sensitive;
      }
    }

    // Log changes
    if (addedVars.length > 0) {
      console.log(chalk.green(`  ➕ Added variables: ${addedVars.join(', ')}`));
    }
    if (updatedVars.length > 0) {
      console.log(chalk.yellow(`  🔄 Updated variables: ${updatedVars.join(', ')}`));
    }
    if (removedVars.length > 0) {
      console.log(chalk.red(`  ➖ Removed variables: ${removedVars.join(', ')}`));
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

  hasConfigurationChanged(
    existing: AgentConfig | null,
    updated: AgentConfig
  ): boolean {
    if (!existing) return true;

    // Compare the pluginParameters
    const existingParams = existing.pluginParameters || {};
    const updatedParams = updated.pluginParameters || {};

    // Check if same number of parameters
    if (
      Object.keys(existingParams).length !== Object.keys(updatedParams).length
    ) {
      return true;
    }

    // Check each parameter
    for (const [key, value] of Object.entries(updatedParams)) {
      const existingValue = existingParams[key];
      if (!existingValue) return true;

      if (
        existingValue.type !== value.type ||
        existingValue.description !== value.description ||
        existingValue.required !== value.required ||
        existingValue.default !== value.default ||
        existingValue.sensitive !== value.sensitive
      ) {
        return true;
      }
    }

    return false;
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
      execSync("git add package.json", { cwd, stdio: "pipe" });
      execSync('git commit -m "chore: update agentConfig and bump version"', {
        cwd,
        stdio: "pipe",
      });

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

  async processRepository(repoName: string): Promise<boolean> {
    const spinner = ora(`Processing ${repoName}...`).start();

    try {
      // Check for 1.x branch
      const branch1xName = await this.get1xBranchName(repoName);

      if (!branch1xName) {
        spinner.succeed(`${repoName}: Skipping - no 1.x branch found`);
        return false;
      }

      const branchToUse = branch1xName;
      spinner.text = `Processing ${repoName} (${branch1xName} branch)...`;

      // Clone repository
      const repoPath = await this.cloneRepository(repoName, branchToUse);

      // Get current agentConfig
      const currentConfig = await this.getCurrentAgentConfig(repoPath);

      // Scan files for environment variables
      const files = await this.scanFilesForEnvVars(repoPath);

      const allEnvVars: EnvVariable[] = [];

              // Analyze files with LLM (in batches to avoid rate limits)
        console.log(chalk.blue(`  📁 Found ${files.length} files to analyze`));
        
        for (let i = 0; i < files.length; i += 5) {
          const batch = files.slice(i, i + 5);
          const batchNum = Math.floor(i / 5) + 1;
          const totalBatches = Math.ceil(files.length / 5);
          
          spinner.text = `Processing ${repoName} - Batch ${batchNum}/${totalBatches} (${batch.length} files)`;
          
          console.log(chalk.cyan(`  🤖 LLM Batch ${batchNum}/${totalBatches}:`));
          
          const batchPromises = batch.map((file) =>
            this.analyzeFileWithLLM(file, currentConfig || undefined)
          );
          const batchResults = await Promise.all(batchPromises);

          for (const result of batchResults) {
            allEnvVars.push(...result);
          }

          // Small delay to respect rate limits
          if (i + 5 < files.length) {
            console.log(chalk.gray(`  ⏳ Waiting 1s to respect API rate limits...`));
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

              // Remove duplicates
        const uniqueEnvVars = allEnvVars.filter(
          (envVar, index, self) =>
            index === self.findIndex((e) => e.name === envVar.name)
        );

        console.log(chalk.green(`  ✨ Analysis complete! Found ${allEnvVars.length} total variables, ${uniqueEnvVars.length} unique`));

        if (uniqueEnvVars.length > 0) {
          console.log(chalk.yellow(`  🔧 Discovered variables: ${uniqueEnvVars.map(v => v.name).join(', ')}`));
        }

      // Merge with existing config
      const updatedConfig = this.mergeEnvVariables(
        currentConfig,
        uniqueEnvVars
      );

              // Check if configuration actually changed
        if (!this.hasConfigurationChanged(currentConfig, updatedConfig)) {
          spinner.succeed(
            `${repoName}: No changes needed - configuration is up to date`
          );
          await fs.remove(repoPath);
          return false;
        }

      // Get version info before update
      const oldPackageJson = await this.getCurrentPackageJson(repoPath);
      const oldVersion = oldPackageJson?.version || "unknown";

              // Update package.json
        console.log(chalk.blue(`  📝 Updating package.json...`));
        const packageUpdated = await this.updatePackageJson(
          repoPath,
          updatedConfig
        );

        // Get new version info
        const newPackageJson = await this.getCurrentPackageJson(repoPath);
        const newVersion = newPackageJson?.version || "unknown";

        console.log(chalk.magenta(`  📦 Version: ${oldVersion} → ${newVersion}`));
        console.log(chalk.blue(`  🚀 Committing and pushing changes...`));
        
        // Commit changes
        const committed = await this.commitChanges(repoPath, repoName);

      const envVarNames = uniqueEnvVars.length > 0 
        ? uniqueEnvVars.map((v) => v.name).join(", ")
        : "configuration cleanup";
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
          `${repoName}: Configuration changed but couldn't update (${envVarNames})`
        );
      }

      // Cleanup
      await fs.remove(repoPath);
      return true;
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
      return false;
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

      // Filter out repositories we don't want to process
      let filteredRepos = repositories.filter((repo) => repo !== "registry");

      // If TARGET_REPO is specified, only process that repository
      if (this.TARGET_REPO) {
        const targetExists = filteredRepos.includes(this.TARGET_REPO);
        if (targetExists) {
          filteredRepos = [this.TARGET_REPO];
          console.log(
            chalk.blue(`🎯 Targeting specific repository: ${this.TARGET_REPO}`)
          );
        } else {
          console.log(
            chalk.red(`❌ Target repository "${this.TARGET_REPO}" not found!`)
          );
          console.log(
            chalk.gray(`Available repositories: ${filteredRepos.join(", ")}`)
          );
          return;
        }
      } else if (repositories.length !== filteredRepos.length) {
        console.log(
          chalk.gray(
            `Filtered out ${
              repositories.length - filteredRepos.length
            } repositories (registry)`
          )
        );
      }

      if (this.TEST_MODE && !this.TARGET_REPO) {
        console.log(
          chalk.yellow("🧪 TEST MODE: Processing until 1 repository is actually processed\n")
        );
        
        // In test mode, keep trying until we find a repo that gets processed
        let processed = false;
        for (const repo of filteredRepos) {
          const result = await this.processRepository(repo);
          if (result) {
            processed = true;
            break;
          }
          // Small delay before trying next repository
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        
        if (!processed) {
          console.log(chalk.yellow("No repositories were processed in test mode"));
        }
      } else {
        const modeInfo = this.TARGET_REPO 
          ? `target repository (${this.TARGET_REPO})`
          : `${filteredRepos.length} repositories`;
        
        console.log(
          chalk.gray(`Processing ${modeInfo}...\n`)
        );

        // Process repositories one by one to avoid overwhelming the APIs
        for (const repo of filteredRepos) {
          await this.processRepository(repo);

          // Small delay between repositories (shorter for single repo)
          const delay = this.TARGET_REPO ? 500 : 2000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
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
