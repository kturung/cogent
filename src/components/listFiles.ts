import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';

function readGitignore(workspacePath: string): string[] {
    const logger = Logger.getInstance();
    const gitignorePath = path.join(workspacePath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        logger.info('No .gitignore file found at: ' + gitignorePath);
        return [];
    }

    try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');

        const patterns = content
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(pattern => pattern.replace(/^\/+|\/+$/g, '')); // Remove leading/trailing slashes
        
        logger.debug('Processed .gitignore patterns: ' + JSON.stringify(patterns, null, 2));
        return patterns;
    } catch (error) {
        logger.error('Error reading .gitignore: ' + error);
        return [];
    }
}

function readGitkeep(workspacePath: string): Set<string> {
    const logger = Logger.getInstance();
    const gitkeepFiles = new Set<string>();

    function findGitkeepFiles(dir: string) {
        try {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                
                if (stat.isDirectory()) {
                    findGitkeepFiles(fullPath);
                } else if (file === '.gitkeep') {
                    // Add the directory containing .gitkeep
                    const dirPath = path.relative(workspacePath, dir);
                    gitkeepFiles.add(dirPath);
                }
            });
        } catch (error) {
            logger.error('Error reading directory for .gitkeep: ' + error);
        }
    }

    findGitkeepFiles(workspacePath);
    logger.debug('Found .gitkeep in directories: ' + JSON.stringify(Array.from(gitkeepFiles), null, 2));
    return gitkeepFiles;
}

const defaultIgnored = [
    // Build and distribution
    'dist',
    'build',
    'out',
    'target',
    'bin',
    'lib',
    '.next',
    'public',
    
    // Dependencies
    'node_modules',
    'package-lock.json',
    'bower_components',
    'vendor',
    'packages',
    
    // Environment and virtual environments
    '.venv',
    'venv',
    'env',
    '.env',
    'virtualenv',
    
    // Version control
    '.git',
    '.svn',
    '.hg',
    
    // IDE and editor files
    '.idea',
    '.vscode',
    '.vs',
    '.sublime-workspace',
    
    // Cache and temp files
    '.cache',
    'tmp',
    'temp',
    '__pycache__',
    
    // System files
    '.DS_Store',
    '*.db',
    
    // Test and coverage
    'coverage',
    '.nyc_output',
    '.pytest_cache',
    
    // Logs
    'logs',
    '*.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',

    // Images and media
    'assets',
    '*.jpg',
    '*.jpeg',
    '*.png',
    '*.gif',
    '*.webp',
    '*.mov',
    '*.flv',
    '*.wmv',
    '*.swf',
    '*.fla',
    '*.svg',
    '*.ico',
    '*.webm',
    '*.woff'

];

function isIgnored(filePath: string, ignorePatterns: string[], gitkeepDirs: Set<string>): boolean {
    // Check if any parent directory contains .gitkeep
    const fileDir = path.dirname(filePath);
    const isInGitkeep = Array.from(gitkeepDirs).some(dir => 
        fileDir === dir || fileDir.startsWith(dir + path.sep)
    );

    // If file is in a .gitkeep directory, don't ignore it
    if (isInGitkeep) {
        return false;
    }

    return ignorePatterns.some(pattern => {
        const cleanPattern = pattern.replace(/\/$/, '');
        const escaped = cleanPattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        const regex = new RegExp(`^${escaped}(?:$|/.*$)`);
        return regex.test(filePath);
    });
}

interface FileDetails {
    structure: string;
    contents: { [path: string]: string };
}

export function listImportantFiles(dir: string, level: number = 0, contents: { [path: string]: string } = {}, ignorePatterns?: string[], gitkeepDirs?: Set<string>): FileDetails {
    const logger = Logger.getInstance();
    let structure = '';
    const list = fs.readdirSync(dir);

    // Only read .gitignore and .gitkeep at root level
    if (level === 0) {
        const gitignorePatterns = readGitignore(dir);
        const defaultIgnoredSet = new Set([...defaultIgnored, ...gitignorePatterns]);
        ignorePatterns = Array.from(defaultIgnoredSet);
        gitkeepDirs = readGitkeep(dir);
        logger.debug('Root level ignore patterns: ' + JSON.stringify(ignorePatterns, null, 2));
    }

    list.forEach(file => {
        const filePath = path.join(dir, file);
        const relativePath = path.relative(dir, filePath);
        const stat = fs.statSync(filePath);

        if (isIgnored(relativePath, ignorePatterns || [], gitkeepDirs || new Set())) {
            return;
        }

        if (stat && stat.isDirectory()) {
            structure += '  '.repeat(level) + file + '/\n';
            const subDirResult = listImportantFiles(filePath, level + 1, contents, ignorePatterns, gitkeepDirs);
            structure += subDirResult.structure;
            Object.assign(contents, subDirResult.contents);
        } else {
            structure += '  '.repeat(level) + file + '\n';
            try {
                // Check file size first
                const stats = fs.statSync(filePath);
                if (stats.size > 1024 * 1024) { // 1MB limit
                    contents[relativePath] = `File too large (${Math.round(stats.size / 1024 / 1024)}MB), skipped`;
                    return;
                }
                contents[relativePath] = fs.readFileSync(filePath, 'utf-8');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                contents[relativePath] = `Error reading file: ${errorMessage}`;
            }
        }
    });

    return { structure, contents };
}
