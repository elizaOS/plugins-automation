import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import process from "process";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ORG_NAME = "elizaos-plugins";
const TARGET_BRANCH = "1.x";
const WORKFLOW_PATH = ".github/workflows/npm-deploy.yml";

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is not set");
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });

  // Load the new GitHub Action workflow from assets
  const workflowPath = path.join(__dirname, "../assets/npm-deploy.yml");
  if (!fs.existsSync(workflowPath)) {
    console.error(`Error: Workflow file not found at ${workflowPath}`);
    process.exit(1);
  }

  const newWorkflowContent = fs.readFileSync(workflowPath, "utf8");
  console.log("Loaded new workflow content from assets/npm-deploy.yml");

  // Get all repositories in the organization
  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org: ORG_NAME,
    per_page: 200,
  });

  for (const repo of repos) {
    console.log(`\n--- Processing ${ORG_NAME}/${repo.name} ---`);

    // Check if 1.x branch exists
    try {
      await octokit.repos.getBranch({
        owner: ORG_NAME,
        repo: repo.name,
        branch: TARGET_BRANCH,
      });
    } catch (error: any) {
      if (error.status === 404) {
        console.log(
          `Skipping ${ORG_NAME}/${repo.name} (no ${TARGET_BRANCH} branch)`
        );
        continue;
      }
      throw error;
    }

    // --- new: skip if package.json version is already 1.0.0 ---
    try {
      const resp = await octokit.repos.getContent({
        owner: ORG_NAME,
        repo: repo.name,
        path: "package.json",
        ref: TARGET_BRANCH,
      });
      if (!Array.isArray(resp.data) && "content" in resp.data) {
        const pkg = JSON.parse(
          Buffer.from(resp.data.content, "base64").toString("utf8")
        );
        if (pkg.version === "1.0.0") {
          console.log(
            `Skipping ${ORG_NAME}/${repo.name} (package.json already @ version 1.0.0)`
          );
          continue;
        }
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
      console.log(
        `  ⚠️ No package.json in ${repo.name}, proceeding with updates`
      );
    }

    try {
      // Update workflow file last (after all other changes)
      await updateWorkflowFile(octokit, repo.name, newWorkflowContent);

      // Remove bun.lock to force regeneration with updated dependencies
      await removeBunLockfile(octokit, repo.name);

      // Update package.json dependencies and version
      await updatePackageJsonDependencies(octokit, repo.name);

      console.log(`✅ Successfully updated ${ORG_NAME}/${repo.name}`);
    } catch (error) {
      console.error(`❌ Error updating ${ORG_NAME}/${repo.name}:`, error);
    }
  }
}

async function updateWorkflowFile(
  octokit: Octokit,
  repoName: string,
  newWorkflowContent: string
): Promise<void> {
  let existingFile;

  // Check if workflow file already exists
  try {
    const response = await octokit.repos.getContent({
      owner: ORG_NAME,
      repo: repoName,
      path: WORKFLOW_PATH,
      ref: TARGET_BRANCH,
    });

    if (Array.isArray(response.data) || !("content" in response.data)) {
      throw new Error("Unexpected response format");
    }
    existingFile = response.data;
  } catch (error: any) {
    if (error.status !== 404) {
      throw error;
    }
    // File doesn't exist, we'll create it
    existingFile = null;
  }

  const encodedContent = Buffer.from(newWorkflowContent, "utf8").toString(
    "base64"
  );

  if (existingFile) {
    // Update existing file
    await octokit.repos.createOrUpdateFileContents({
      owner: ORG_NAME,
      repo: repoName,
      path: WORKFLOW_PATH,
      branch: TARGET_BRANCH,
      message: "chore: update npm deployment workflow",
      content: encodedContent,
      sha: existingFile.sha,
    });
    console.log(`  📝 Updated workflow file in ${repoName}`);
  } else {
    // Create new file
    await octokit.repos.createOrUpdateFileContents({
      owner: ORG_NAME,
      repo: repoName,
      path: WORKFLOW_PATH,
      branch: TARGET_BRANCH,
      message: "chore: add npm deployment workflow",
      content: encodedContent,
    });
    console.log(`  ➕ Created workflow file in ${repoName}`);
  }
}

async function updatePackageJsonDependencies(
  octokit: Octokit,
  repoName: string
): Promise<void> {
  let packageFile;

  // Get package.json
  try {
    const response = await octokit.repos.getContent({
      owner: ORG_NAME,
      repo: repoName,
      path: "package.json",
      ref: TARGET_BRANCH,
    });

    if (Array.isArray(response.data) || !("content" in response.data)) {
      throw new Error("Unexpected response format");
    }
    packageFile = response.data;
  } catch (error: any) {
    if (error.status === 404) {
      console.log(`  ⚠️ No package.json found in ${repoName}`);
      return;
    }
    throw error;
  }

  const packageContent = Buffer.from(packageFile.content, "base64").toString(
    "utf8"
  );
  const pkg = JSON.parse(packageContent) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    [key: string]: any;
  };

  let updated = false;

  // Update package version to 1.0.0
  if (pkg.version !== "1.0.0") {
    const currentVersion = pkg.version;
    pkg.version = "1.0.0";
    console.log(`  📦 Updated version: ${currentVersion} → 1.0.0`);
    updated = true;
  }

  // Update @elizaos/core version in all dependency types
  const dependencyTypes = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ] as const;

  for (const depType of dependencyTypes) {
    if (pkg[depType] && pkg[depType]!["@elizaos/core"]) {
      const currentVersion = pkg[depType]!["@elizaos/core"];
      if (currentVersion !== "^1.0.0") {
        pkg[depType]!["@elizaos/core"] = "^1.0.0";
        console.log(
          `  🔄 Updated @elizaos/core in ${depType}: ${currentVersion} → ^1.0.0`
        );
        updated = true;
      }
    }
  }

  if (updated) {
    const updatedContent = Buffer.from(
      JSON.stringify(pkg, null, 2) + "\n",
      "utf8"
    ).toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG_NAME,
      repo: repoName,
      path: "package.json",
      branch: TARGET_BRANCH,
      message: "chore: update version to 1.0.0 and @elizaos/core to ^1.0.0",
      content: updatedContent,
      sha: packageFile.sha,
    });
    console.log(`  📦 Updated package.json dependencies in ${repoName}`);
  } else {
    console.log(
      `  ✓ @elizaos/core dependencies already up to date in ${repoName}`
    );
  }
}

async function removeBunLockfile(
  octokit: Octokit,
  repoName: string
): Promise<void> {
  try {
    // First get the file to get its SHA
    const response = await octokit.repos.getContent({
      owner: ORG_NAME,
      repo: repoName,
      path: "bun.lock",
      ref: TARGET_BRANCH,
    });

    if (Array.isArray(response.data) || !("content" in response.data)) {
      return;
    }

    // Delete the file using the SHA
    await octokit.repos.deleteFile({
      owner: ORG_NAME,
      repo: repoName,
      path: "bun.lock",
      branch: TARGET_BRANCH,
      message: "chore: remove bun.lock to regenerate with updated dependencies",
      sha: response.data.sha,
    });
    console.log(
      `  🗑️ Removed bun.lock in ${repoName} (will be regenerated on next install)`
    );
  } catch (error: any) {
    if (error.status === 404) {
      console.log(`  ℹ️ No bun.lock found in ${repoName}`);
    } else {
      console.warn(
        `  ⚠️ Could not remove bun.lock in ${repoName}:`,
        error.message
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
