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

### NPM Download Statistics - `npmDownloadStats.ts`

This script generates comprehensive download statistics for all packages in the @elizaos npm organization and exports the data to a professional Excel report:

- **Package Discovery**: Searches both `@elizaos` and `@elizaos-plugins` npm organizations to find all published packages
- **Download Analytics**: Collects weekly, monthly, and yearly download statistics for each package
- **Package Metadata**: Gathers comprehensive information including descriptions, versions, repositories, maintainers, keywords, and licenses
- **Version Analysis**: Provides estimated download statistics for recent versions of each package
- **Excel Generation**: Creates a multi-sheet Excel document with detailed analytics and summaries

**Excel Report Structure:**
- **Package Overview**: Complete package details with download counts and metadata
- **Package Downloads**: Download statistics broken down by time periods (weekly/monthly/yearly)
- **Version Downloads**: Estimated downloads for the most recent versions of each package
- **Summary**: Key metrics, totals, and top-performing packages

**Sample Results:**
The script currently discovers 178+ packages across the ElizaOS ecosystem with metrics like:
- 1.25M+ total yearly downloads
- 78K+ weekly downloads
- Top package: `@elizaos/core` with 211K+ yearly downloads

**Features:**
- Automated package discovery across multiple npm organizations
- Rate-limited API calls to respect npm registry limits
- Robust error handling with fallback for missing data
- Progress indicators and detailed console output
- Professional Excel formatting with multiple analysis sheets

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

#### NPM Download Statistics

```bash
npm run npm-download-stats
```

This will:

- Search for all packages in both `@elizaos` and `@elizaos-plugins` npm organizations
- Collect comprehensive download statistics (weekly, monthly, yearly) for each package
- Gather package metadata including descriptions, versions, and maintainers
- Generate a professional Excel report with multiple analysis sheets
- Save the report as `assets/elizaos-npm-download-stats.xlsx`

**No prerequisites required** - this script only reads public npm registry data

### Generate READMEs - `generateReadmes.ts`

This script automatically generates comprehensive README documentation for all plugins in the `elizaos-plugins` organization:

- **Plugin Discovery**: Automatically finds all plugin repositories (those starting with `plugin-`) in the GitHub organization
- **Code Analysis**: Extracts plugin information including:
  - Actions, services, and providers with their descriptions
  - Environment variables used throughout the codebase
  - Dependencies and package metadata
  - Parameter types and usage examples
- **AI Enhancement**: Uses OpenAI GPT-4o to generate detailed, well-structured README files that include:
  - Installation instructions
  - Configuration guides with all environment variables
  - Usage examples for each action
  - API documentation for services and providers
  - Development and testing instructions
- **Content Preservation**: When updating existing READMEs, the script preserves all custom sections like "Future Enhancements", "Credits", and "Security Best Practices"
- **Pull Request Creation**: Automatically creates pull requests with the updated documentation

**Features:**
- Template-based generation with AI enhancement for better descriptions
- Intelligent merging of existing content with new documentation
- Source code analysis to extract accurate component information
- Support for both local and remote repository processing
- Test mode for safe development (`--test` flag)
- Local mode for processing without GitHub operations (`--local` flag)

#### Generate READMEs Usage

```bash
# Generate READMEs for all plugins
npm run generate-readmes

# Test mode - process only one plugin
npm run generate-readmes:test

# Local mode - process local plugins without creating PRs
npm run generate-readmes:local

# Process a specific repository in test mode
npm run generate-readmes:test -- --repo=plugin-example
```

**Prerequisites for Generate READMEs:**
- `GITHUB_TOKEN` environment variable with repo permissions (for remote operations)
- `OPENAI_API_KEY` environment variable for AI-enhanced documentation generation
- README template file at `assets/readme-template.md`

The script will:
- Clone each plugin repository (or use local copies in local mode)
- Analyze the codebase to extract plugin components and functionality
- Generate comprehensive documentation using AI assistance
- Create pull requests with the updated README files
- Clean up temporary files after processing
