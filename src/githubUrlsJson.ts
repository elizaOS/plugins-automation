import { Octokit } from "@octokit/rest";
import process from "process";
import dotenv from "dotenv";

dotenv.config();

const ORG_NAME = "elizaos-plugins";
const TARGET_BRANCH = "1.x";
const TEST_MODE = false; // Set to false to run on all repos
const TEST_REPO = "plugin-knowledge"; // Specific repo to test with

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is not set");
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });

  if (TEST_MODE) {
    console.log(`🧪 TEST MODE: Only processing repository '${TEST_REPO}'`);
  }

  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org: ORG_NAME,
    per_page: 100,
  });

  for (const repo of repos) {
    // In test mode, only process the specified test repo
    if (TEST_MODE && repo.name !== TEST_REPO) {
      continue;
    }

    let fileData;

    // Check if 1.x branch exists, if not skip
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

    try {
      const response = await octokit.repos.getContent({
        owner: ORG_NAME,
        repo: repo.name,
        path: "package.json",
        ref: TARGET_BRANCH,
      });
      if (Array.isArray(response.data) || !("content" in response.data)) {
        continue;
      }
      fileData = response.data;
    } catch (error: any) {
      if (error.status === 404) {
        console.log(
          `Skipping ${ORG_NAME}/${repo.name} (no package.json on ${TARGET_BRANCH})`
        );
        continue;
      }
      throw error;
    }

    const raw = Buffer.from(fileData.content, "base64").toString("utf8");
    const pkg = JSON.parse(raw) as {
      name?: string;
      version?: string;
      repository?: string | { type: string; url: string };
      [key: string]: any;
    };

    // Check if repository field needs to be updated
    const expectedRepositoryUrl = `https://github.com/${ORG_NAME}/${repo.name}.git`;
    let needsRepositoryUpdate = false;

    if (!pkg.repository) {
      // No repository field at all
      needsRepositoryUpdate = true;
    } else if (typeof pkg.repository === "string") {
      // Repository is a string - should be an object
      needsRepositoryUpdate = true;
    } else if (typeof pkg.repository === "object") {
      // Repository is an object - check if URL is empty or incorrect
      if (
        !pkg.repository.url ||
        pkg.repository.url === "" ||
        pkg.repository.url !== expectedRepositoryUrl
      ) {
        needsRepositoryUpdate = true;
      }
    }

    if (!needsRepositoryUpdate) {
      console.log(
        `Skipping ${ORG_NAME}/${repo.name} (repository field is already correct)`
      );
      continue;
    }

    // Add or update the repository URL
    pkg.repository = {
      type: "git",
      url: expectedRepositoryUrl,
    };

    // Bump the version number appropriately
    if (pkg.version) {
      if (pkg.version.includes("-beta.")) {
        // Handle beta versions (e.g., 1.0.0-beta.55 -> 1.0.0-beta.56)
        const betaMatch = pkg.version.match(/^(.+)-beta\.(\d+)$/);
        if (betaMatch && betaMatch[1] && betaMatch[2]) {
          const baseVersion = betaMatch[1];
          const betaNumber = parseInt(betaMatch[2], 10);
          if (!isNaN(betaNumber)) {
            pkg.version = `${baseVersion}-beta.${betaNumber + 1}`;
          }
        }
      } else {
        // Handle regular semantic versions
        const versionParts = pkg.version.split(".");
        if (versionParts.length >= 3 && versionParts[2]) {
          // Increment patch version
          const patchVersion = parseInt(versionParts[2], 10);
          if (!isNaN(patchVersion)) {
            versionParts[2] = (patchVersion + 1).toString();
            pkg.version = versionParts.join(".");
          }
        }
      }
    }

    const updated = Buffer.from(
      JSON.stringify(pkg, null, 2) + "\n",
      "utf8"
    ).toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG_NAME,
      repo: repo.name,
      path: "package.json",
      branch: TARGET_BRANCH,
      message: `chore: update repository URL and bump version in package.json`,
      content: updated,
      sha: fileData.sha,
    });

    console.log(
      `Updated repository URL and bumped version in package.json for ${ORG_NAME}/${repo.name} on ${TARGET_BRANCH} branch`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
