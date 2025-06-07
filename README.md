# plugins-automation

Automation scripts to manage the 150+ plugins in eliza-plugins organization.

## Scripts

### Package Scope Rename - `packageNames.ts`

This script updates the `name` field in `package.json` for all repositories in the `elizaos-plugins` GitHub organization only on `1.x` branch, changing the scope from `@elizaos-plugins/*` to `@elizaos/*`.

### GitHub Repository URL Update - `githubUrlsJson.ts`

This script updates the `repository` field in `package.json` for all repositories in the `elizaos-plugins` GitHub organization on the `1.x` branch with:

- **Repository URL**: Sets or updates the repository field to the correct GitHub URL format
- **Version bump**: Automatically increments the patch version (handles both regular semantic versions and beta versions)

The script processes repositories and:

1. Checks if the repository field needs updating (missing, incorrect format, or wrong URL)
2. Updates the repository field with the correct git URL format
3. Bumps the version number appropriately (patch increment or beta increment)
4. Commits the changes with a descriptive message

### Plugin Migration - `migratePlugins.ts`

This script automates the migration of plugins in the `elizaos-plugins` organization from 0.x to 1.x compatibility by:

- **Repository Discovery**: Fetches all repositories from the `elizaos-plugins` GitHub organization
- **Branch Detection**: Identifies repositories that don't have a `1.x` branch yet
- **Automated Migration**: For each repository without a 1.x branch:
  1. Clones the repository locally
  2. Creates a new `1.x-migrate` branch
  3. Runs `elizaos plugins upgrade .` to perform the migration
  4. Commits any changes with the message "feat: migrate to 1.x compatibility"
  5. Pushes the new branch to origin
- **Error Handling**: Continues processing other repositories if one fails
- **Cleanup**: Automatically removes temporary directories after processing
- **Test Mode**: Set `TEST_MODE = true` in the script to process only 1 repository for testing

### Release V1 - `releaseV1.ts`

This script updates all repositories in the `elizaos-plugins` organization that have a `1.x` branch with:

- **GitHub Actions workflow**: Updates `.github/workflows/npm-deploy.yml` with the latest deployment configuration
- **Package version**: Sets the package version to `1.0.0`
- **Dependencies**: Updates `@elizaos/core` dependency to `^1.0.0` in all dependency types
- **Lockfile cleanup**: Removes `bun.lock` files to force regeneration with updated dependencies

The script processes repositories in the following order:

1. Update `package.json` (version and dependencies)
2. Remove `bun.lock` lockfile
3. Update GitHub Actions workflow file (last)

### Agent Config Scanner - `agentConfigScan.ts`

This comprehensive script scans all repositories in the `elizaos-plugins` organization to automatically discover and document environment variables:

- **Environment Variable Discovery**: Uses OpenAI GPT-4o to analyze source code, README files, and configuration files to identify all environment variables used in each plugin
- **agentConfig Updates**: Automatically updates or creates the `agentConfig` section in `package.json` with discovered environment variables, including:
  - Variable names and types (string, number, boolean)
  - Descriptions based on code analysis
  - Required/optional status
  - Default values when available

- **Version Bumping**: Automatically increments the patch version of each plugin when changes are made
- **Branch Detection**: Only processes repositories that have exactly a `1.x` branch
- **Repository Filtering**: Automatically excludes non-plugin repositories (e.g., registry)
- **Batch Processing**: Processes files in batches to respect API rate limits
- **Git Integration**: Automatically commits and pushes changes with descriptive commit messages

**Features:**
- Smart duplicate detection and merging with existing configurations
- Comprehensive file scanning (TypeScript, JavaScript, Markdown, JSON)  
- Robust error handling and cleanup
- Rate limiting for OpenAI API calls
- Progress indicators with detailed status reporting
- Test mode for safe development and testing (processes only 1 repository)

## Usage

### Prerequisites

1. Set a GitHub personal access token with repo permissions and copy `.env.example` -> `.env`
2. Install dependencies: `npm install`
3. Build the project: `npm run build`

### Running Scripts

#### Package Scope Rename

```bash
npm run package-names
```

#### GitHub Repository URL Update

```bash
npm run github-urls-json
```

#### Plugin Migration

```bash
npm run migrate-plugins
```

**Prerequisites for Plugin Migration:**
- `GITHUB_TOKEN` environment variable with repo permissions
- `ANTHROPIC_API_KEY` environment variable (required by elizaos plugins upgrade)
- `elizaos` CLI available globally or via npx

#### Release V1 Update

```bash
npm run release-v1
```

This will:

- Load the GitHub Actions workflow from `assets/npm-deploy.yml`
- Process all repositories in the `elizaos-plugins` organization with a `1.x` branch
- Update package versions, dependencies, and workflow files
- Remove lockfiles to ensure fresh dependency resolution

#### Agent Config Scanner

```bash
npm run agent-config-scan
```

This will:

- Scan all repositories in the `elizaos-plugins` organization for environment variables
- Use OpenAI to analyze code and documentation files
- Update `agentConfig` sections in `package.json` files with discovered variables
- Automatically bump package versions and commit changes

**Prerequisites for Agent Config Scanner:**
- `GITHUB_TOKEN` environment variable with repo permissions
- `OPENAI_API_KEY` environment variable for LLM analysis
- Optional: `GIT_USER_NAME` and `GIT_USER_EMAIL` for custom commit attribution

**Test Mode**: Set `TEST_MODE = true` in the script to process only 1 repository for testing
