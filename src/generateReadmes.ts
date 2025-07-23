#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import OpenAI from 'openai';

// Load environment variables
dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_ORG = 'elizaos-plugins';
const MAIN_BRANCH = 'main';
const README_TEMPLATE_PATH = path.join(process.cwd(), 'assets/readme-template.md');
const TEST_MODE = process.argv.includes('--test');
const LOCAL_MODE = process.argv.includes('--local');
const TEST_REPO = process.argv.find(arg => arg.startsWith('--repo='))?.split('=')[1];

interface ComponentInfo {
  name: string;
  sourceCode?: string;
  filePath?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  returnType?: string;
  methods?: Array<{
    name: string;
    parameters: string;
    description: string;
  }>;
  aliases?: string[];
  usageExample?: string;
  configuration?: string;
}

interface PluginInfo {
  name: string;
  description: string;
  packageName: string;
  actions: ComponentInfo[];
  services: ComponentInfo[];
  providers: ComponentInfo[];
  events: string[];
  evaluators: string[];
  envVars: string[];
  dependencies: string[];
  repository: string;
  hasTests: boolean;
}

// Initialize GitHub client
const octokit = GITHUB_TOKEN ? new Octokit({
  auth: GITHUB_TOKEN,
}) : null;

async function getLocalPlugins(): Promise<{ name: string; path: string }[]> {
  const rootDir = path.join(process.cwd(), '..');
  const items = await fs.readdir(rootDir);
  const plugins: { name: string; path: string }[] = [];
  
  for (const item of items) {
    if (item.startsWith('plugin-')) {
      const pluginPath = path.join(rootDir, item);
      const stat = await fs.stat(pluginPath);
      if (stat.isDirectory()) {
        plugins.push({ name: item, path: pluginPath });
      }
    }
  }
  
  return plugins;
}

async function getPluginRepositories(): Promise<string[]> {
  if (LOCAL_MODE) {
    const localPlugins = await getLocalPlugins();
    console.log(chalk.blue(`Found ${localPlugins.length} local plugins`));
    return localPlugins.map(p => p.name);
  }
  
  if (TEST_MODE && TEST_REPO) {
    return [TEST_REPO];
  }

  if (!octokit) {
    throw new Error('GitHub token required for remote repository operations');
  }

  const spinner = ora('Fetching plugin repositories...').start();
  
  try {
    // Get all repositories in the organization
    const repos = await octokit.repos.listForOrg({
      org: GITHUB_ORG,
      type: 'all',
      per_page: 100,
    });

    const pluginRepos = repos.data
      .filter(repo => repo.name.startsWith('plugin-'))
      .map(repo => repo.name);

    spinner.succeed(`Found ${pluginRepos.length} plugin repositories`);
    return pluginRepos;
  } catch (error) {
    spinner.fail('Failed to fetch repositories');
    throw error;
  }
}

async function getPluginPath(repoNameOrUrl: string): Promise<string> {
  if (LOCAL_MODE) {
    // Extract repo name from URL if needed
    const isUrl = repoNameOrUrl.startsWith('http://') || repoNameOrUrl.startsWith('https://');
    let repoName: string;
    
    if (isUrl) {
      const urlParts = repoNameOrUrl.split('/');
      const lastPart = urlParts[urlParts.length - 1];
      if (!lastPart) {
        throw new Error(`Invalid URL format: ${repoNameOrUrl}`);
      }
      repoName = lastPart.replace('.git', '');
    } else {
      repoName = repoNameOrUrl;
    }
    
    // For local mode, return the actual plugin path
    const localPath = path.join(process.cwd(), '..', repoName);
    if (await fs.pathExists(localPath)) {
      return localPath;
    }
    throw new Error(`Local plugin ${repoName} not found at ${localPath}`);
  }
  
  // For remote mode, clone the repository
  return cloneRepository(repoNameOrUrl);
}

async function cloneRepository(repoNameOrUrl: string): Promise<string> {
  const spinner = ora(`Cloning ${repoNameOrUrl}...`).start();
  
  // Determine if it's a URL or just a repo name
  const isUrl = repoNameOrUrl.startsWith('http://') || repoNameOrUrl.startsWith('https://');
  
  // Extract repo name for the temp directory
  let repoName: string;
  let cloneUrl: string;
  
  if (isUrl) {
    // Extract repo name from URL
    const urlParts = repoNameOrUrl.split('/');
    const lastPart = urlParts[urlParts.length - 1];
    if (!lastPart) {
      throw new Error(`Invalid URL format: ${repoNameOrUrl}`);
    }
    repoName = lastPart.replace('.git', '');
    cloneUrl = repoNameOrUrl;
    
    // Add .git if not present
    if (!cloneUrl.endsWith('.git')) {
      cloneUrl += '.git';
    }
  } else {
    // It's just a repo name, construct the URL
    repoName = repoNameOrUrl;
    cloneUrl = `https://github.com/${GITHUB_ORG}/${repoName}.git`;
  }
  
  const tempDir = path.join(process.cwd(), 'temp', repoName);
  
  try {
    // Clean up if exists
    await fs.remove(tempDir);
    
    // Clone the repository
    execSync(`git clone ${cloneUrl} ${tempDir}`, {
      stdio: 'pipe',
    });

    spinner.succeed(`Cloned ${repoName}`);
    return tempDir;
  } catch (error) {
    spinner.fail(`Failed to clone ${repoName}`);
    throw error;
  }
}

function extractDetailedComponentInfo(sourceCode: string, componentName: string, type: 'actions' | 'services' | 'providers'): Partial<ComponentInfo> {
  const info: Partial<ComponentInfo> = {};
  
  // Extract description from JSDoc comments
  const jsdocRegex = /\/\*\*([\s\S]*?)\*\/[\s\n]*(?:export\s+)?(?:const|class|function|interface)\s+(\w+)/g;
  let match;
  while ((match = jsdocRegex.exec(sourceCode)) !== null) {
    const [, jsdocContent, identifier] = match;
    if (identifier === componentName || identifier === `${componentName}Action` || identifier === `${componentName}Service` || identifier === `${componentName}Provider`) {
      if (jsdocContent) {
        // Extract description
        const descMatch = jsdocContent.match(/@description\s+(.+)|^\s*\*\s+([^@].+)/m);
        if (descMatch) {
          const desc = descMatch[1] || descMatch[2];
          if (desc) {
            info.description = desc.trim();
          }
        }
      }
    }
  }
  
  // Extract interface for parameters (for actions)
  if (type === 'actions') {
    // Look for action interface
    const interfaceRegex = new RegExp(`interface\\s+${componentName}(?:Action)?(?:Content|Input|Params)?\\s*{([^}]+)}`, 's');
    const interfaceMatch = sourceCode.match(interfaceRegex);
    if (interfaceMatch) {
      const interfaceBody = interfaceMatch[1];
      const params: ComponentInfo['parameters'] = [];
      
      // Extract parameters from interface
      const paramRegex = /^\s*(\w+)(\?)?:\s*([^;]+);?\s*(?:\/\/\s*(.+))?/gm;
      let paramMatch;
      while (interfaceBody && (paramMatch = paramRegex.exec(interfaceBody)) !== null) {
        const [, paramName, optional, paramType, paramDesc] = paramMatch;
        if (paramName && paramType) {
          params.push({
            name: paramName,
            type: paramType.trim(),
            required: !optional,
            description: paramDesc || ''
          });
        }
      }
      
      if (params.length > 0) {
        info.parameters = params;
      }
    }
    
    // Look for aliases
    const aliasRegex = /aliases\s*:\s*\[([^\]]+)\]/;
    const aliasMatch = sourceCode.match(aliasRegex);
    if (aliasMatch && aliasMatch[1]) {
      info.aliases = aliasMatch[1].split(',').map(a => a.trim().replace(/['"]/g, ''));
    }
    
    // Look for validation schema
    const schemaRegex = new RegExp(`${componentName}(?:Action)?Schema\\s*=\\s*z\\.object\\({([^}]+)}`, 's');
    const schemaMatch = sourceCode.match(schemaRegex);
    if (schemaMatch && !info.parameters) {
      const schemaBody = schemaMatch[1];
      const params: ComponentInfo['parameters'] = [];
      
      // Extract parameters from zod schema
      const zodParamRegex = /(\w+):\s*z\.(\w+)\((.*?)\)(?:\.(\w+)\((.*?)\))*/g;
      let zodMatch;
      while (schemaBody && (zodMatch = zodParamRegex.exec(schemaBody)) !== null) {
        const [, paramName, paramType, paramDesc, optionalFlag] = zodMatch;
        if (paramName && paramType) {
          const isOptional = optionalFlag === 'optional';
          params.push({
            name: paramName,
            type: paramType,
            required: !isOptional,
            description: paramDesc ? paramDesc.replace(/['"]/g, '') : ''
          });
        }
      }
      
      if (params.length > 0) {
        info.parameters = params;
      }
    }
  }
  
  // Extract methods for services
  if (type === 'services') {
    const methods: ComponentInfo['methods'] = [];
    
    // Look for class methods
    const methodRegex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*{/g;
    let methodMatch;
    while ((methodMatch = methodRegex.exec(sourceCode)) !== null) {
      const methodName = methodMatch[1];
      if (methodName && methodName !== 'constructor' && !methodName.startsWith('_')) {
        // Extract method signature
        const fullMethodRegex = new RegExp(`(?:async\\s+)?${methodName}\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{]+))?`, 's');
        const fullMatch = sourceCode.match(fullMethodRegex);
        if (fullMatch) {
          methods.push({
            name: methodName,
            parameters: fullMatch[1] || '',
            description: '' // Could extract from JSDoc if available
          });
        }
      }
    }
    
    if (methods.length > 0) {
      info.methods = methods;
    }
  }
  
  return info;
}

async function readComponentSource(repoPath: string, componentName: string, type: 'actions' | 'services' | 'providers'): Promise<string | undefined> {
  const possiblePaths = [
    path.join(repoPath, 'src', type, `${componentName}.ts`),
    path.join(repoPath, 'src', type, `${componentName}.js`),
    path.join(repoPath, 'src', type, `${componentName}/index.ts`),
    path.join(repoPath, 'src', type, `${componentName}/index.js`),
  ];

  // Also check without the type suffix (e.g., "userAction" -> "user")
  const baseName = componentName.replace(/Action$|Service$|Provider$/, '');
  if (baseName !== componentName) {
    possiblePaths.push(
      path.join(repoPath, 'src', type, `${baseName}.ts`),
      path.join(repoPath, 'src', type, `${baseName}.js`),
      path.join(repoPath, 'src', type, `${baseName}/index.ts`),
      path.join(repoPath, 'src', type, `${baseName}/index.js`)
    );
  }

  for (const filePath of possiblePaths) {
    if (await fs.pathExists(filePath)) {
      try {
        return await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        // Continue to next path
      }
    }
  }

  return undefined;
}

async function extractPluginComponents(repoPath: string, indexContent: string, pluginInfo: PluginInfo): Promise<void> {
  // First, look for imports to understand what's being used
  const imports: { [key: string]: string } = {};
  const importMatches = indexContent.matchAll(/import\s+{?\s*([^}]+?)(?:\s+as\s+(\w+))?\s*}?\s+from\s+['"](.*?)['"]/g);
  for (const match of importMatches) {
    const importName = match[2] || (match[1] ? match[1].trim() : '');
    const importPath = match[3] || '';
    if (importName && importPath) {
      imports[importName] = importPath;
    }
  }

  // Extract from index file
  if (indexContent) {
    // Extract actions - handle various patterns including imported references
    const actionPatterns = [
      /actions:\s*\[(.*?)\]/s,
      /export\s+const\s+actions\s*=\s*\[(.*?)\]/s,
      /\.actions\s*=\s*\[(.*?)\]/s,
      /export\s+default\s+{\s*[^}]*actions:\s*\[(.*?)\]/s,
    ];
    
    // First look for action imports to get better names
    const actionImports = new Map<string, string>();
    const importMatches = indexContent.matchAll(/import\s+(?:{([^}]+)}|(\w+))\s+from\s+["']\.\/actions(?:\/([^"']+))?["']/g);
    
    for (const match of importMatches) {
      if (match[1]) {
        // Named imports
        const imports = match[1].split(',').map(s => s.trim());
        imports.forEach(imp => {
          const parts = imp.split(' as ');
          const alias = parts[parts.length - 1];
          const original = parts[0] || alias;
          if (alias && original) {
            actionImports.set(alias, original);
          }
        });
      } else if (match[2]) {
        // Default import
        actionImports.set(match[2], match[2]);
      }
    }
    
    for (const pattern of actionPatterns) {
      const match = indexContent.match(pattern);
      if (match && match[1]) {
        // Extract action names from the match
        const content = match[1];
        
        // Remove comments from content to avoid extracting comment words
        const cleanContent = content
          .replace(/\/\/.*$/gm, '') // Remove single-line comments
          .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments
        
        // Look for all word references in the actions array
        const allRefs = cleanContent.match(/\b[a-zA-Z_]\w+\b/g) || [];
        
        // Also look for inline action objects with name property
        const inlineActions = cleanContent.matchAll(/{[^}]*name:\s*["'](\w+)["'][^}]*}/g);
        
        const actionComponents: ComponentInfo[] = [];
        const foundNames = new Set<string>();
        
        // Add all non-keyword references
        const keywords = ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue'];
        for (const ref of allRefs) {
          if (ref && !keywords.includes(ref) && !foundNames.has(ref)) {
            // Use the import name if available
            const importName = actionImports.get(ref);
            const componentName = importName || ref;
            foundNames.add(componentName);
            
            // Try to read source code
            const sourceCode = await readComponentSource(repoPath, componentName, 'actions');
            const component: ComponentInfo = { name: componentName };
            if (sourceCode) {
              component.sourceCode = sourceCode;
              component.filePath = `src/actions/${componentName}`;
              // Extract detailed information
              const detailedInfo = extractDetailedComponentInfo(sourceCode, componentName, 'actions');
              Object.assign(component, detailedInfo);
            }
            actionComponents.push(component);
          }
        }
        
        // Add inline action names
        for (const inlineMatch of inlineActions) {
          if (inlineMatch[1] && !foundNames.has(inlineMatch[1])) {
            const componentName = inlineMatch[1];
            foundNames.add(componentName);
            
            const sourceCode = await readComponentSource(repoPath, componentName, 'actions');
            const component: ComponentInfo = { name: componentName };
            if (sourceCode) {
              component.sourceCode = sourceCode;
              component.filePath = `src/actions/${componentName}`;
              // Extract detailed information
              const detailedInfo = extractDetailedComponentInfo(sourceCode, componentName, 'actions');
              Object.assign(component, detailedInfo);
            }
            actionComponents.push(component);
          }
        }
        
        if (actionComponents.length > 0) {
          pluginInfo.actions = actionComponents;
          break;
        }
      }
    }

    // Extract services - handle various patterns
    const servicePatterns = [
      /services:\s*\[(.*?)\]/s,
      /export\s+const\s+services\s*=\s*\[(.*?)\]/s,
      /\.services\s*=\s*\[(.*?)\]/s,
    ];
    
    for (const pattern of servicePatterns) {
      const match = indexContent.match(pattern);
      if (match && match[1]) {
        // Remove comments
        const cleanContent = match[1]
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        const serviceNames = cleanContent.match(/\w+Service\b/g) || [];
        if (serviceNames.length > 0) {
          const serviceComponents: ComponentInfo[] = [];
          for (const serviceName of serviceNames) {
            const sourceCode = await readComponentSource(repoPath, serviceName, 'services');
            const component: ComponentInfo = { name: serviceName };
            if (sourceCode) {
              component.sourceCode = sourceCode;
              component.filePath = `src/services/${serviceName}`;
              // Extract detailed information
              const detailedInfo = extractDetailedComponentInfo(sourceCode, serviceName, 'services');
              Object.assign(component, detailedInfo);
            }
            serviceComponents.push(component);
          }
          pluginInfo.services = serviceComponents;
          break;
        }
      }
    }

    // Extract providers - handle various patterns
    const providerPatterns = [
      /providers:\s*\[(.*?)\]/s,
      /export\s+const\s+providers\s*=\s*\[(.*?)\]/s,
      /\.providers\s*=\s*\[(.*?)\]/s,
      /export\s+default\s+{\s*[^}]*providers:\s*\[(.*?)\]/s,
    ];
    
    // First look for provider imports
    const providerImports = new Map<string, string>();
    const providerImportMatches = indexContent.matchAll(/import\s+(?:{([^}]+)}|(\w+))\s+from\s+["']\.\/providers(?:\/([^"']+))?["']/g);
    
    for (const match of providerImportMatches) {
      if (match[1]) {
        // Named imports
        const imports = match[1].split(',').map(s => s.trim());
        imports.forEach(imp => {
          const parts = imp.split(' as ');
          const alias = parts[parts.length - 1];
          const original = parts[0] || alias;
          if (alias && original) {
            providerImports.set(alias, original);
          }
        });
      } else if (match[2]) {
        // Default import
        providerImports.set(match[2], match[2]);
      }
    }
    
    for (const pattern of providerPatterns) {
      const match = indexContent.match(pattern);
      if (match && match[1]) {
        // Remove comments
        const cleanContent = match[1]
          .replace(/\/\/.*$/gm, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        
        // Look for all word references
        const allRefs = cleanContent.match(/\b[a-zA-Z_]\w+\b/g) || [];
        
        const providerComponents: ComponentInfo[] = [];
        const foundNames = new Set<string>();
        const keywords = ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue'];
        
        for (const ref of allRefs) {
          if (ref && !keywords.includes(ref) && !foundNames.has(ref)) {
            // Use the import name if available
            const importName = providerImports.get(ref);
            const componentName = importName || ref;
            foundNames.add(componentName);
            
            const sourceCode = await readComponentSource(repoPath, componentName, 'providers');
            const component: ComponentInfo = { name: componentName };
            if (sourceCode) {
              component.sourceCode = sourceCode;
              component.filePath = `src/providers/${componentName}`;
              // Extract detailed information
              const detailedInfo = extractDetailedComponentInfo(sourceCode, componentName, 'providers');
              Object.assign(component, detailedInfo);
            }
            providerComponents.push(component);
          }
        }
        
        if (providerComponents.length > 0) {
          pluginInfo.providers = providerComponents;
          break;
        }
      }
    }

    // Extract events and evaluators
    const eventMatch = indexContent.match(/events:\s*\[(.*?)\]/s);
    if (eventMatch && eventMatch[1]) {
      pluginInfo.events = eventMatch[1].match(/\w+/g) || [];
    }

    const evaluatorMatch = indexContent.match(/evaluators:\s*\[(.*?)\]/s);
    if (evaluatorMatch && evaluatorMatch[1]) {
      pluginInfo.evaluators = evaluatorMatch[1].match(/\w+/g) || [];
    }
  }

  // If we didn't find components in the index, look in directories
  const srcPath = path.join(repoPath, 'src');
  
  // Look for actions directory
  const actionsPath = path.join(srcPath, 'actions');
  if (await fs.pathExists(actionsPath) && pluginInfo.actions.length === 0) {
    try {
      const actionFiles = await fs.readdir(actionsPath);
      const actionComponents: ComponentInfo[] = [];
      
      for (const file of actionFiles) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          const filePath = path.join(actionsPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Look for action exports
          const exportMatches = content.match(/export\s+(?:const|class|function)\s+(\w+)(?:Action)?/g);
          if (exportMatches) {
            for (const match of exportMatches) {
              const nameMatch = match.match(/export\s+(?:const|class|function)\s+(\w+)/);
              if (nameMatch && nameMatch[1]) {
                actionComponents.push({
                  name: nameMatch[1],
                  sourceCode: content,
                  filePath: `src/actions/${file}`
                });
              }
            }
          }
          
          // Also look for default exports with action names
          const defaultExportMatch = content.match(/export\s+default\s+{[^}]*name:\s*["'](\w+)["']/s);
          if (defaultExportMatch && defaultExportMatch[1]) {
            actionComponents.push({
              name: defaultExportMatch[1],
              sourceCode: content,
              filePath: `src/actions/${file}`
            });
          }
        }
      }
      
      if (actionComponents.length > 0) {
        pluginInfo.actions = actionComponents;
      }
    } catch (error) {
      // Ignore errors reading action directory
    }
  }

  // Look for services directory
  const servicesPath = path.join(srcPath, 'services');
  if (await fs.pathExists(servicesPath) && pluginInfo.services.length === 0) {
    try {
      const serviceFiles = await fs.readdir(servicesPath);
      const serviceComponents: ComponentInfo[] = [];
      
      for (const file of serviceFiles) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          const filePath = path.join(servicesPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Look for service exports
          const exportMatches = content.match(/export\s+(?:const|class|function)\s+(\w+)(?:Service)?/g);
          if (exportMatches) {
            for (const match of exportMatches) {
              const nameMatch = match.match(/export\s+(?:const|class|function)\s+(\w+)/);
              if (nameMatch && nameMatch[1]) {
                serviceComponents.push({
                  name: nameMatch[1],
                  sourceCode: content,
                  filePath: `src/services/${file}`
                });
              }
            }
          }
        }
      }
      
      if (serviceComponents.length > 0) {
        pluginInfo.services = serviceComponents;
      }
    } catch (error) {
      // Ignore errors reading service directory
    }
  }

  // Look for providers directory
  const providersPath = path.join(srcPath, 'providers');
  if (await fs.pathExists(providersPath) && pluginInfo.providers.length === 0) {
    try {
      const providerFiles = await fs.readdir(providersPath);
      const providerComponents: ComponentInfo[] = [];
      
      for (const file of providerFiles) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          const filePath = path.join(providersPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Look for provider exports
          const exportMatches = content.match(/export\s+(?:const|class|function)\s+(\w+)(?:Provider)?/g);
          if (exportMatches) {
            for (const match of exportMatches) {
              const nameMatch = match.match(/export\s+(?:const|class|function)\s+(\w+)/);
              if (nameMatch && nameMatch[1]) {
                providerComponents.push({
                  name: nameMatch[1],
                  sourceCode: content,
                  filePath: `src/providers/${file}`
                });
              }
            }
          }
        }
      }
      
      if (providerComponents.length > 0) {
        pluginInfo.providers = providerComponents;
      }
    } catch (error) {
      // Ignore errors reading provider directory
    }
  }
}

async function extractPluginInfo(repoPath: string): Promise<PluginInfo> {
  const spinner = ora('Extracting plugin information...').start();
  
  try {
    // Read package.json
    const packageJsonPath = path.join(repoPath, 'package.json');
    const packageJson = await fs.readJson(packageJsonPath);
    
    // Extract basic info and normalize package name
    const normalizedPackageName = (packageJson.name || '').replace('@elizaos-plugins/', '@elizaos/');
    const pluginInfo: PluginInfo = {
      name: normalizedPackageName,
      description: packageJson.description || '',
      packageName: normalizedPackageName,
      actions: [],
      services: [],
      providers: [],
      events: [],
      evaluators: [],
      envVars: [],
      dependencies: Object.keys(packageJson.dependencies || {}),
      repository: packageJson.repository?.url || '',
      hasTests: await fs.pathExists(path.join(repoPath, '__tests__')) || 
                await fs.pathExists(path.join(repoPath, 'src/__tests__')),
    };

    // Try to read the main index file
    const indexPaths = [
      path.join(repoPath, 'src/index.ts'),
      path.join(repoPath, 'src/index.js'),
      path.join(repoPath, 'index.ts'),
      path.join(repoPath, 'index.js'),
    ];

    let indexContent = '';
    for (const indexPath of indexPaths) {
      if (await fs.pathExists(indexPath)) {
        indexContent = await fs.readFile(indexPath, 'utf-8');
        break;
      }
    }

    // Extract plugin components
    await extractPluginComponents(repoPath, indexContent, pluginInfo);

    // Extract environment variables
    const envVars = new Set<string>();
    
    // Search for environment variables in all source files
    const searchForEnvVars = async (dir: string) => {
      const files = await fs.readdir(dir);
      
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath);
        
        if (stat.isDirectory() && !file.includes('node_modules') && !file.includes('.git')) {
          await searchForEnvVars(filePath);
        } else if (file.endsWith('.ts') || file.endsWith('.js')) {
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Look for environment variable patterns
          const envPatterns = [
            /process\.env\.(\w+)/g,
            /getSetting\(['"](\w+)['"]\)/g,
            /getEnv\(['"](\w+)['"]\)/g,
            /runtime\.getSetting\(['"](\w+)['"]\)/g,
          ];
          
          for (const pattern of envPatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
              if (match[1]) {
                // Add all environment variables, not just those with plugin prefix
                envVars.add(match[1]);
              }
            }
          }
        }
      }
    };

    const srcPath = path.join(repoPath, 'src');
    if (await fs.pathExists(srcPath)) {
      await searchForEnvVars(srcPath);
    } else {
      // If no src directory, search the root
      await searchForEnvVars(repoPath);
    }
    
    pluginInfo.envVars = Array.from(envVars).sort();

    spinner.succeed('Extracted plugin information');
    return pluginInfo;
  } catch (error) {
    spinner.fail('Failed to extract plugin information');
    throw error;
  }
}

async function generateReadme(pluginInfo: PluginInfo, templatePath: string, existingReadme?: string): Promise<string> {
  const spinner = ora('Generating README...').start();
  
  try {
    // Check if we have OpenAI API key for enhanced generation
    const openaiKey = process.env.OPENAI_API_KEY;
    
    if (openaiKey && !process.argv.includes('--no-ai')) {
      try {
        spinner.text = 'Generating README with AI enhancement...';
        const readme = await generateReadmeWithAI(pluginInfo, templatePath, existingReadme);
        spinner.succeed('Generated README with AI enhancement');
        return readme;
      } catch (error) {
        spinner.warn('AI generation failed, falling back to template');
        console.error('AI error:', error);
      }
    }
    
    // Fallback to template-based generation
    const readme = await generateReadmeFromTemplate(pluginInfo, templatePath, existingReadme);
    
    spinner.succeed('Generated README successfully');
    return readme;
  } catch (error) {
    spinner.fail('Failed to generate README');
    throw error;
  }
}

async function generateReadmeWithAI(pluginInfo: PluginInfo, templatePath: string, existingReadme?: string): Promise<string> {
  const spinner = ora('Generating README with OpenAI...').start();
  
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Read the template
    const template = await fs.readFile(templatePath, 'utf-8');
    
    // Create a comprehensive prompt
    let prompt = `You are enhancing a README.md file for an ElizaOS plugin. 

YOUR MOST IMPORTANT RULE: NEVER DELETE CONTENT. You must include EVERYTHING from the existing README in your output, plus any improvements.

Plugin Details:
- Package Name: ${pluginInfo.packageName}
- Description: ${pluginInfo.description || 'A plugin for ElizaOS that extends agent capabilities.'}
- Repository: ${pluginInfo.repository || 'https://github.com/elizaos/eliza'}

Components Found in Code:
- Actions (${pluginInfo.actions.length}): ${pluginInfo.actions.length > 0 ? pluginInfo.actions.map(a => `\n  - ${a.name}`).join('') : 'None found'}
- Services (${pluginInfo.services.length}): ${pluginInfo.services.length > 0 ? pluginInfo.services.map(s => `\n  - ${s.name}`).join('') : 'None found'} 
- Providers (${pluginInfo.providers.length}): ${pluginInfo.providers.length > 0 ? pluginInfo.providers.map(p => `\n  - ${p.name}`).join('') : 'None found'}
- Environment Variables (${pluginInfo.envVars.length}): ${pluginInfo.envVars.length > 0 ? pluginInfo.envVars.map(e => `\n  - ${e}`).join('') : 'None found'}`;

    // If existing README exists, include it for context
    if (existingReadme && existingReadme.trim().length > 0) {
      prompt += `\n\n=== EXISTING README CONTENT (THIS IS YOUR STARTING POINT) ===
${existingReadme}

=== END EXISTING README ===

CRITICAL: The existing README above is your foundation. You must:
- KEEP ALL SECTIONS that don't exist in the template - DO NOT DELETE THEM:
  * Future Enhancements
  * Credits
  * Security Best Practices
  * Development Guide
  * ANY other custom sections
- PRESERVE ALL detailed content, examples, explanations, and links
- ONLY update content if you're adding new information or fixing errors
- MERGE template requirements with existing content, don't replace wholesale
- The final README should have MORE content than the original, not less
- Maintain the original tone and style
- If you see detailed lists (like 8 future enhancement categories), KEEP THEM ALL
- If you see acknowledgments and credits, KEEP THEM ALL
- If you see external documentation links, KEEP THEM ALL

REMEMBER: You are ENHANCING the documentation, not rewriting it from scratch!`;
    }

    // Add source code for components if available
    let componentSourceCode = '';
    
    if (pluginInfo.actions.length > 0) {
      componentSourceCode += '\n\n=== ACTIONS ===\n';
      for (const action of pluginInfo.actions) {
        componentSourceCode += `\n--- ${action.name} ---\n`;
        if (action.description) {
          componentSourceCode += `Description: ${action.description}\n`;
        }
        if (action.aliases && action.aliases.length > 0) {
          componentSourceCode += `Aliases: ${action.aliases.join(', ')}\n`;
        }
        if (action.parameters && action.parameters.length > 0) {
          componentSourceCode += `Parameters:\n`;
          action.parameters.forEach(param => {
            componentSourceCode += `  - ${param.name} (${param.type}${param.required ? ', required' : ', optional'}): ${param.description}\n`;
          });
        }
        if (action.sourceCode) {
          componentSourceCode += `\nSource Code (${action.filePath}):\n`;
          componentSourceCode += action.sourceCode.substring(0, 1500); // Limit to first 1500 chars
          if (action.sourceCode.length > 1500) {
            componentSourceCode += '\n... [truncated]';
          }
        }
        componentSourceCode += '\n';
      }
    }
    
    if (pluginInfo.services.length > 0) {
      componentSourceCode += '\n\n=== SERVICE SOURCE CODE ===\n';
      for (const service of pluginInfo.services) {
        if (service.sourceCode) {
          componentSourceCode += `\n--- ${service.name} (${service.filePath}) ---\n`;
          componentSourceCode += service.sourceCode.substring(0, 2000);
          if (service.sourceCode.length > 2000) {
            componentSourceCode += '\n... [truncated]';
          }
          componentSourceCode += '\n';
        }
      }
    }
    
    if (pluginInfo.providers.length > 0) {
      componentSourceCode += '\n\n=== PROVIDER SOURCE CODE ===\n';
      for (const provider of pluginInfo.providers) {
        if (provider.sourceCode) {
          componentSourceCode += `\n--- ${provider.name} (${provider.filePath}) ---\n`;
          componentSourceCode += provider.sourceCode.substring(0, 2000);
          if (provider.sourceCode.length > 2000) {
            componentSourceCode += '\n... [truncated]';
          }
          componentSourceCode += '\n';
        }
      }
    }
    
    if (componentSourceCode) {
      prompt += componentSourceCode;
    }

    prompt += `\n\nInstructions:

DO NOT:
- ❌ Delete the "Future Enhancements" section
- ❌ Delete the "Credits" section
- ❌ Delete the "Security Best Practices" section
- ❌ Delete any custom sections
- ❌ Remove detailed lists or simplify them
- ❌ Remove external documentation links
- ❌ Replace detailed content with generic descriptions

DO:
- ✅ KEEP ALL existing sections, even if not in the template
- ✅ ADD new sections from the template if missing
- ✅ MERGE information intelligently when sections overlap
- ✅ Use 'bun' instead of 'npm' in ALL commands
- ✅ Enhance descriptions based on the source code provided
- ✅ Fix any outdated information
- ✅ Add more examples and details
- ✅ For Actions: Include parameter tables, usage examples, return types, and aliases from the extracted information
- ✅ For Services: Document all methods with their signatures and purposes
- ✅ For Providers: Explain what context they provide and when they run

APPROACH:
1. Start with the ENTIRE existing README
2. Add any missing sections from the template
3. Enhance existing sections with better descriptions (using source code context)
4. Fix any errors or outdated information
5. Ensure all custom sections are preserved

The template below is just the MINIMUM structure - your output should include EVERYTHING from the existing README plus enhancements:

${template}`;

    spinner.text = 'Calling OpenAI API...';
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o', // You can also use 'gpt-4' or 'gpt-3.5-turbo' for faster/cheaper generation
      messages: [
        {
          role: 'system',
          content: 'You are a documentation PRESERVATIONIST and enhancer. Your PRIMARY DIRECTIVE is to NEVER delete existing content. You must KEEP ALL existing sections including Future Enhancements, Credits, Security Best Practices, etc. You ADD and ENHANCE, but NEVER REMOVE. If you see a section in the existing README, it MUST appear in your output.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
              temperature: 0.3, // Lower temperature for more consistent, instruction-following output
    });

    const readme = completion.choices[0]?.message?.content || '';
    
    if (!readme || readme.trim().length < 500) {
      throw new Error('OpenAI returned insufficient content');
    }

    // Validate against existing README if present
    if (existingReadme && existingReadme.trim().length > 0) {
      const existingLength = existingReadme.trim().length;
      const newLength = readme.trim().length;
      
      if (newLength < existingLength * 0.8) {
        console.warn(chalk.yellow(`\n⚠️  Warning: New README (${newLength} chars) is significantly shorter than existing (${existingLength} chars)`));
        console.warn(chalk.yellow('This might indicate lost content. Please review carefully.\n'));
      }
      
      // Check for missing important sections
      const importantSections = [
        'Future Enhancements',
        'Credits',
        'Security Best Practices',
        'Development Guide'
      ];
      
      const missingSections: string[] = [];
      for (const section of importantSections) {
        if (existingReadme.includes(`## ${section}`) && !readme.includes(`## ${section}`)) {
          missingSections.push(section);
        }
      }
      
      if (missingSections.length > 0) {
        console.warn(chalk.red(`\n⚠️  CRITICAL: The following sections were removed from the README:`));
        missingSections.forEach(section => {
          console.warn(chalk.red(`   - ${section}`));
        });
        console.warn(chalk.yellow('\nThis indicates the AI did not follow preservation instructions. Consider regenerating.\n'));
      }
    }

    spinner.succeed('Generated README with AI enhancement');
    
    // Log preview
    console.log(chalk.blue('\n=== GENERATED README PREVIEW (first 500 chars) ==='));
    console.log(chalk.gray(readme.substring(0, 500) + '...'));
    console.log(chalk.blue('=== END PREVIEW ===\n'));
    
    return readme.trim();
  } catch (error) {
    spinner.fail('AI generation failed');
    console.error('OpenAI error:', error);
    
    // Fall back to template generation
    return generateReadmeFromTemplate(pluginInfo, templatePath, existingReadme);
  }
}

async function generateReadmeFromTemplate(pluginInfo: PluginInfo, templatePath: string, _existingReadme?: string): Promise<string> {
  const template = await fs.readFile(templatePath, 'utf-8');
  
  // Replace placeholders in template
  let readme = template
    .replace(/{{PLUGIN_NAME}}/g, pluginInfo.packageName)
    .replace(/{{PLUGIN_DESCRIPTION}}/g, pluginInfo.description)
    .replace(/{{PACKAGE_NAME}}/g, pluginInfo.packageName)
    .replace(/{{REPOSITORY_URL}}/g, pluginInfo.repository);

  // Generate environment variables section
  const envVarsSection = pluginInfo.envVars.length > 0
    ? pluginInfo.envVars.map(env => `${env}=your_${env.toLowerCase()}_here`).join('\n')
    : '# No environment variables required';
  readme = readme.replace(/{{ENV_VARS}}/g, envVarsSection);

  // Generate actions list
  const actionsSection = pluginInfo.actions.length > 0
    ? pluginInfo.actions.map(action => `- **${action.name}**: <!-- TODO: Add description -->`).join('\n')
    : '- No actions available';
  readme = readme.replace(/{{ACTIONS_LIST}}/g, actionsSection);

  // Generate services list
  const servicesSection = pluginInfo.services.length > 0
    ? pluginInfo.services.map(service => `- **${service.name}**: <!-- TODO: Add description -->`).join('\n')
    : '- No services available';
  readme = readme.replace(/{{SERVICES_LIST}}/g, servicesSection);

  // Generate providers list
  const providersSection = pluginInfo.providers.length > 0
    ? pluginInfo.providers.map(provider => `- **${provider.name}**: <!-- TODO: Add description -->`).join('\n')
    : '- No providers available';
  readme = readme.replace(/{{PROVIDERS_LIST}}/g, providersSection);

  // Generate detailed action documentation
  let actionsDetailed = '';
  if (pluginInfo.actions.length > 0) {
    actionsDetailed = pluginInfo.actions.map(action => {
      let section = `#### ${action.name}\n\n`;
      section += `${action.description || 'Description of this action'}\n\n`;
      
      if (action.parameters && action.parameters.length > 0) {
        section += `**Parameters:**\n\n`;
        section += `| Parameter | Type | Required | Description |\n`;
        section += `|-----------|------|----------|-------------|\n`;
        action.parameters.forEach(param => {
          section += `| \`${param.name}\` | \`${param.type}\` | ${param.required ? 'Yes' : 'No'} | ${param.description} |\n`;
        });
        section += `\n`;
      } else {
        section += `**Parameters:** This action does not require any parameters.\n\n`;
      }
      
      section += `**Usage:**\n\`\`\`typescript\n// Example usage of ${action.name}\n${action.usageExample || `await runtime.useAction('${action.name}', { /* parameters */ });`}\n\`\`\`\n\n`;
      
      if (action.returnType) {
        section += `**Output:**\n\`\`\`typescript\n${action.returnType}\n\`\`\`\n\n`;
      }
      
      if (action.aliases && action.aliases.length > 0) {
        section += `**Aliases:** ${action.aliases.join(', ')}\n\n`;
      }
      
      return section;
    }).join('\n---\n\n');
  } else {
    actionsDetailed = 'No actions found in this plugin.';
  }
  
  // Generate detailed service documentation
  let servicesDetailed = '';
  if (pluginInfo.services.length > 0) {
    servicesDetailed = pluginInfo.services.map(service => {
      let section = `#### ${service.name}\n\n`;
      section += `${service.description || 'Description of this service'}\n\n`;
      
      if (service.methods && service.methods.length > 0) {
        section += `**Methods:**\n\n`;
        service.methods.forEach(method => {
          section += `- \`${method.name}(${method.parameters})\`: ${method.description || 'Method description'}\n`;
        });
        section += `\n`;
      }
      
      if (service.configuration) {
        section += `**Configuration:**\n\`\`\`typescript\n${service.configuration}\n\`\`\`\n\n`;
      }
      
      section += `**Usage Example:**\n\`\`\`typescript\n${service.usageExample || `const service = runtime.getService('${service.name}');\n// Use service methods here`}\n\`\`\`\n\n`;
      
      return section;
    }).join('\n---\n\n');
  } else {
    servicesDetailed = 'No services found in this plugin.';
  }
  
  // Generate detailed provider documentation
  let providersDetailed = '';
  if (pluginInfo.providers.length > 0) {
    providersDetailed = pluginInfo.providers.map(provider => {
      let section = `#### ${provider.name}\n\n`;
      section += `${provider.description || 'Description of this provider'}\n\n`;
      
      section += `**Provided Context:**\n\`\`\`typescript\n${provider.returnType || '// Context structure'}\n\`\`\`\n\n`;
      
      section += `**Usage:**\n\`\`\`typescript\n// The ${provider.name} provider supplies the following context\n${provider.usageExample || '// Context is automatically included in agent prompts'}\n\`\`\`\n\n`;
      
      section += `**When This Provider Runs:**\n${provider.configuration || 'This provider runs before each agent action to supply relevant context.'}\n\n`;
      
      return section;
    }).join('\n---\n\n');
  } else {
    providersDetailed = 'No providers found in this plugin.';
  }

  // Replace detailed sections
  readme = readme.replace(/{{ACTIONS_DETAILED}}/g, actionsDetailed);
  readme = readme.replace(/{{SERVICES_DETAILED}}/g, servicesDetailed);
  readme = readme.replace(/{{PROVIDERS_DETAILED}}/g, providersDetailed);

  return readme;
}

async function createPullRequest(repoName: string, readme: string): Promise<void> {
  if (LOCAL_MODE) {
    // For local mode, just write the README
    // Ensure we're writing to the correct plugin directory
    const currentDir = process.cwd();
    const isInPluginsAutomation = currentDir.endsWith('plugins-automation');
    const pluginPath = isInPluginsAutomation 
      ? path.join(currentDir, '..', repoName)  // Go up one level from plugins-automation
      : path.join(currentDir, repoName);       // Use current directory
    
    const readmePath = path.join(pluginPath, 'README.md');
    
    // Validate the path exists
    if (!await fs.pathExists(pluginPath)) {
      throw new Error(`Plugin directory not found: ${pluginPath}`);
    }
    
    // Safety check: never overwrite plugins-automation README
    if (readmePath.includes('plugins-automation/README.md')) {
      throw new Error('CRITICAL: Attempted to overwrite plugins-automation README!');
    }
    
    console.log(chalk.blue(`Writing README to ${readmePath}`));
    await fs.writeFile(readmePath, readme);
    console.log(chalk.green(`✅ README written successfully`));
    return;
  }

  if (!octokit) {
    throw new Error('GitHub token required for creating pull requests');
  }

  const spinner = ora(`Creating pull request for ${repoName}...`).start();
  
  try {
    const branchName = `update-readme-${Date.now()}`;
    const repoPath = path.join(process.cwd(), 'temp', repoName);
    
    // Create new branch
    execSync(`git checkout -b ${branchName}`, { cwd: repoPath });
    
    // Write README
    await fs.writeFile(path.join(repoPath, 'README.md'), readme);
    
    // Commit changes
    execSync('git add README.md', { cwd: repoPath });
    execSync('git commit -m "docs: update README with comprehensive documentation"', { cwd: repoPath });
    
    // Push branch
    execSync(`git push origin ${branchName}`, { cwd: repoPath });
    
    // Create pull request
    const pr = await octokit.pulls.create({
      owner: GITHUB_ORG,
      repo: repoName,
      title: 'docs: Update README with comprehensive documentation',
      body: `This PR updates the README.md with comprehensive documentation including:

- Proper installation instructions with bun
- Complete list of environment variables
- Usage examples for all actions
- Feature descriptions
- Development instructions

Generated by the plugins-automation script.`,
      head: branchName,
      base: MAIN_BRANCH,
    });

    spinner.succeed(`Created PR #${pr.data.number} for ${repoName}`);
  } catch (error) {
    spinner.fail(`Failed to create PR for ${repoName}`);
    throw error;
  }
}

async function processPlugin(repoNameOrUrl: string): Promise<void> {
  console.log(chalk.blue(`\n📦 Processing ${repoNameOrUrl}...`));
  
  let repoPath: string | null = null;
  let repoName: string;
  
  // Extract the actual repo name from URL if needed
  const isUrl = repoNameOrUrl.startsWith('http://') || repoNameOrUrl.startsWith('https://');
  
  if (isUrl) {
    const urlParts = repoNameOrUrl.split('/');
    const lastPart = urlParts[urlParts.length - 1];
    if (!lastPart) {
      throw new Error(`Invalid URL format: ${repoNameOrUrl}`);
    }
    repoName = lastPart.replace('.git', '');
  } else {
    repoName = repoNameOrUrl;
  }
  
  try {
    
    // Get plugin path (local or cloned)
    repoPath = await getPluginPath(repoNameOrUrl);
    
    // Extract plugin information
    const pluginInfo = await extractPluginInfo(repoPath);
    
    // Read existing README if it exists
    const readmePath = path.join(repoPath, 'README.md');
    let existingReadme = '';
    if (await fs.pathExists(readmePath)) {
      existingReadme = await fs.readFile(readmePath, 'utf-8');
    }
    
    // Generate README
    const readme = await generateReadme(pluginInfo, README_TEMPLATE_PATH, existingReadme);
    
    // Validate that we have a valid README
    if (!readme || readme.trim().length === 0) {
      throw new Error('Generated README is empty');
    }
    
    // Only create pull request if README generation was successful
    // Use the extracted repo name, not the original URL
    await createPullRequest(repoName, readme);
    
    // Clean up if it was a cloned repo
    if (!LOCAL_MODE && repoPath) {
      await fs.remove(repoPath);
    }
    
    console.log(chalk.green(`✅ Successfully processed ${repoName}`));
  } catch (error) {
    console.error(chalk.red(`❌ Failed to process ${repoName}:`), error);
    // Clean up on error
    if (!LOCAL_MODE && repoPath) {
      await fs.remove(repoPath).catch(() => {});
    }
  }
}

async function main() {
  console.log(chalk.bold.blue('🚀 ElizaOS Plugin README Generator'));
  console.log(chalk.gray('This script will generate comprehensive READMEs for all plugins\n'));

  if (!LOCAL_MODE && !GITHUB_TOKEN) {
    console.error(chalk.red('❌ GITHUB_TOKEN environment variable is required for remote operations'));
    console.log(chalk.yellow('💡 Tip: Use --local flag to process local plugins without GitHub token'));
    process.exit(1);
  }

  try {
    // Ensure temp directory exists
    await fs.ensureDir(path.join(process.cwd(), 'temp'));
    
    // Ensure template exists
    if (!await fs.pathExists(README_TEMPLATE_PATH)) {
      console.error(chalk.red(`❌ README template not found at ${README_TEMPLATE_PATH}`));
      process.exit(1);
    }
    
    // Get plugin repositories
    const repositories = await getPluginRepositories();
    
    if (TEST_MODE) {
      console.log(chalk.yellow(`\n⚠️  Running in TEST MODE - Processing only: ${repositories.slice(0, 1).join(', ')}\n`));
    }
    
    if (LOCAL_MODE) {
      console.log(chalk.yellow(`\n📁 Running in LOCAL MODE - Processing local plugins\n`));
    }

    // Process each plugin
    let pluginsToProcess = repositories;
    
    if (TEST_MODE) {
      if (TEST_REPO) {
        // If specific repo is specified, only process that one
        pluginsToProcess = repositories.filter(r => r === TEST_REPO);
        if (pluginsToProcess.length === 0) {
          console.error(chalk.red(`❌ Repository ${TEST_REPO} not found`));
          process.exit(1);
        }
      } else {
        // Otherwise, just process the first one
        pluginsToProcess = repositories.slice(0, 1);
      }
    }
    
    for (const repo of pluginsToProcess) {
      await processPlugin(repo);
    }

    // Clean up temp directory
    await fs.remove(path.join(process.cwd(), 'temp'));
    
    console.log(chalk.bold.green('\n✅ All plugins processed successfully!'));
  } catch (error) {
    console.error(chalk.red('❌ Script failed:'), error);
    process.exit(1);
  }
}

// Run the script
main().catch(console.error); 