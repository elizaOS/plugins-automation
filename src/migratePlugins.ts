#!/usr/bin/env node

import { Octokit } from '@octokit/rest';
import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';

// GitHub configuration
const ORG_NAME = 'elizaos-plugins';
const TEMP_DIR = path.join(process.cwd(), 'temp-migration');
const TEST_MODE = false; // Set to true to process only 1 repository for testing

interface Repository {
  name: string;
  clone_url: string;
  has_1x_branch: boolean;
}

async function main() {
  const spinner = ora('Starting plugin migration process...').start();
  
  try {
    // Initialize GitHub client
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }

    // Get all repositories in the organization
    spinner.text = 'Fetching repositories from elizaos-plugins org...';
    const repos = await getAllRepositories(octokit);
    spinner.succeed(`Found ${repos.length} repositories`);

    // Check which repos don't have 1.x branch
    spinner.start('Checking for existing 1.x branches...');
    let reposToMigrate = await filterReposWithout1xBranch(octokit, repos);
    
    // Apply TEST_MODE filter if enabled
    if (TEST_MODE && reposToMigrate.length > 0) {
      reposToMigrate = [reposToMigrate[0]!];
      spinner.succeed(`Found ${reposToMigrate.length} repository for testing (TEST_MODE enabled)`);
    } else {
      spinner.succeed(`Found ${reposToMigrate.length} repositories without 1.x branch`);
    }

    if (reposToMigrate.length === 0) {
      console.log(chalk.green('✅ All repositories already have 1.x branches!'));
      return;
    }

    console.log(chalk.blue(`\n📋 Repositories to migrate:`));
    reposToMigrate.forEach(repo => {
      console.log(chalk.gray(`  - ${repo.name}`));
    });

    // Ensure temp directory exists and is clean
    await fs.ensureDir(TEMP_DIR);
    await fs.emptyDir(TEMP_DIR);

    // Process each repository
    for (let i = 0; i < reposToMigrate.length; i++) {
      const repo = reposToMigrate[i];
      if (!repo) continue;
      
      const progress = `(${i + 1}/${reposToMigrate.length})`;
      
      try {
        await migrateRepository(repo, progress);
        console.log(chalk.green(`✅ ${progress} Successfully migrated ${repo.name}`));
      } catch (error) {
        console.error(chalk.red(`❌ ${progress} Failed to migrate ${repo.name}:`), (error as Error).message);
        continue; // Continue with next repo
      }
    }

    // Cleanup
    await fs.remove(TEMP_DIR);
    console.log(chalk.green('\n🎉 Migration process completed!'));

  } catch (error) {
    spinner.fail('Migration process failed');
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exit(1);
  }
}

async function getAllRepositories(octokit: Octokit): Promise<Repository[]> {
  const repositories: Repository[] = [];
  let page = 1;
  
  while (true) {
    const response = await octokit.repos.listForOrg({
      org: ORG_NAME,
      per_page: 100,
      page,
    });
    
    if (response.data.length === 0) break;
    
    repositories.push(...response.data.map((repo: any) => ({
      name: repo.name,
      clone_url: repo.clone_url || '',
      has_1x_branch: false, // Will be checked later
    })));
    
    page++;
  }
  
  return repositories;
}

async function filterReposWithout1xBranch(octokit: Octokit, repos: Repository[]): Promise<Repository[]> {
  const reposToMigrate: Repository[] = [];
  
  for (const repo of repos) {
    try {
      // Check if 1.x branch exists
      await octokit.repos.getBranch({
        owner: ORG_NAME,
        repo: repo.name,
        branch: '1.x',
      });
      // If we get here, the branch exists
      repo.has_1x_branch = true;
    } catch (error) {
      if ((error as any).status === 404) {
        // Branch doesn't exist, add to migration list
        reposToMigrate.push(repo);
      } else {
        console.warn(chalk.yellow(`⚠️  Could not check branch for ${repo.name}: ${(error as Error).message}`));
      }
    }
  }
  
  return reposToMigrate;
}

async function migrateRepository(repo: Repository, progress: string): Promise<void> {
  const repoDir = path.join(TEMP_DIR, repo.name);
  const spinner = ora(`${progress} Processing ${repo.name}...`).start();
  
  try {
    // Clone the repository
    spinner.text = `${progress} Cloning ${repo.name}...`;
    await execa('git', ['clone', repo.clone_url, repoDir], {
      stdio: 'pipe'
    });
    
    // Change to repo directory
    process.chdir(repoDir);
    
    // Create and checkout new branch
    spinner.text = `${progress} Creating 1.x-migrate branch...`;
    await execa('git', ['checkout', '-b', '1.x-migrate'], {
      stdio: 'pipe'
    });
    
    // Run elizaos plugins upgrade command
    spinner.text = `${progress} Running elizaos plugins upgrade on ${repo.name}...`;
    await execa('npx', ['elizaos', 'plugins', 'upgrade', '.'], {
      stdio: 'pipe',
      cwd: repoDir,
    });
    
    // Check if there are any changes to commit
    const { stdout: status } = await execa('git', ['status', '--porcelain'], {
      stdio: 'pipe'
    });
    
    if (status.trim() === '') {
      spinner.warn(`${progress} No changes detected for ${repo.name}, skipping...`);
      return;
    }
    
    // Stage all changes
    spinner.text = `${progress} Staging changes...`;
    await execa('git', ['add', '.'], {
      stdio: 'pipe'
    });
    
    // Commit changes
    spinner.text = `${progress} Committing changes...`;
    await execa('git', ['commit', '-m', 'feat: migrate to 1.x compatibility'], {
      stdio: 'pipe'
    });
    
    // Push the new branch
    spinner.text = `${progress} Pushing 1.x-migrate branch...`;
    await execa('git', ['push', 'origin', '1.x-migrate'], {
      stdio: 'pipe'
    });
    
    spinner.succeed(`${progress} Successfully migrated ${repo.name}`);
    
  } catch (error) {
    spinner.fail(`${progress} Failed to migrate ${repo.name}`);
    throw error;
  } finally {
    // Change back to original directory
    process.chdir(path.dirname(TEMP_DIR));
    
    // Clean up this repo directory
    try {
      await fs.remove(repoDir);
    } catch (cleanupError) {
      console.warn(chalk.yellow(`⚠️  Could not cleanup ${repoDir}: ${(cleanupError as Error).message}`));
    }
  }
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n⚠️  Process interrupted. Cleaning up...'));
  try {
    await fs.remove(TEMP_DIR);
  } catch (error) {
    // Ignore cleanup errors on exit
  }
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}