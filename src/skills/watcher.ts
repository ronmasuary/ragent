import path from 'path';
import { fileURLToPath } from 'url';
import chokidar from 'chokidar';
import type { Skill } from './types.js';
import { tryLoadSkill, installSkillDeps } from './loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

/**
 * Watch skills/ for new subdirectories and hot-load them.
 *
 * NOTE: Only NEW skill directories are hot-loaded. Updating code in an
 * already-loaded skill has no effect — ESM import() caches by URL permanently.
 * Skill code updates require an agent restart.
 */
export function startSkillWatcher(
  onNewSkill: (skill: Skill) => void,
  alreadyLoaded: Set<string>,
  setCacheInvalidated: () => void,
): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  chokidar.watch(SKILLS_DIR, { depth: 1, ignoreInitial: true })
    .on('all', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void scanForNewSkills(onNewSkill, alreadyLoaded, setCacheInvalidated);
      }, 500);
    })
    .on('error', (err) => {
      console.error('[SkillWatcher] Watch error:', err);
    });

  console.error('[SkillWatcher] Watching skills/ for new skills...');
}

async function scanForNewSkills(
  onNewSkill: (skill: Skill) => void,
  alreadyLoaded: Set<string>,
  setCacheInvalidated: () => void,
): Promise<void> {
  const fs = await import('fs');
  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR).filter(name =>
      fs.statSync(path.join(SKILLS_DIR, name)).isDirectory() && !alreadyLoaded.has(name)
    );
  } catch {
    return;
  }

  for (const name of entries) {
    await installSkillDeps(name);
    const skill = await tryLoadSkill(name);
    if (skill) {
      alreadyLoaded.add(name);
      onNewSkill(skill);
      setCacheInvalidated();
      console.error(`[SkillWatcher] Hot-loaded new skill: ${skill.name}`);
    }
  }
}

/** Trigger a manual re-scan (used by POST /skills/reload). */
export async function rescanSkills(
  onNewSkill: (skill: Skill) => void,
  alreadyLoaded: Set<string>,
  setCacheInvalidated: () => void,
): Promise<void> {
  await scanForNewSkills(onNewSkill, alreadyLoaded, setCacheInvalidated);
}
