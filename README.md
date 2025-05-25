# plugins-automation

Automation scripts to manage the 150+ plugins in eliza-plugins organization.

## Rename package scope script

### `packageNames.ts`

This script updates the `name` field in `package.json` for all repositories in the `elizaos-plugins` GitHub organization only on `1.x` branch, changing the scope from `@elizaos-plugins/*` to `@elizaos/*`.

### Usage

1. Set a GitHub personal access token with repo permissions and copy `.env.example` -> `.env`

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the project
   ```bash
   npm run build
   ```

4. Run the script

   ```bash
   npm run package-names
   ```
