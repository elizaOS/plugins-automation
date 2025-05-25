import { Octokit } from "@octokit/rest";
import process from "process";
import dotenv from "dotenv";

dotenv.config();

const ORG_NAME = "elizaos-plugins";
const TARGET_BRANCH = "1.x";

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is not set");
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });

  const repos = await octokit.paginate(octokit.repos.listForOrg, {
    org: ORG_NAME,
    per_page: 100,
  });

  for (const repo of repos) {
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
    const pkg = JSON.parse(raw) as { name?: string; [key: string]: any };
    const oldName = pkg.name;
    if (!oldName || !oldName.startsWith("@elizaos-plugins/")) {
      continue;
    }

    const newName = oldName.replace(/^@elizaos-plugins\//, "@elizaos/");
    pkg.name = newName;

    const updated = Buffer.from(
      JSON.stringify(pkg, null, 2) + "\n",
      "utf8"
    ).toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG_NAME,
      repo: repo.name,
      path: "package.json",
      branch: TARGET_BRANCH,
      message: `chore: rename scope to @elizaos in package.json`,
      content: updated,
      sha: fileData.sha,
    });

    console.log(
      `Updated package.json in ${ORG_NAME}/${repo.name} on ${TARGET_BRANCH} branch`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
