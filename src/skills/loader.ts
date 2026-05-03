import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import type { Skill } from './types.js';
import type { IdentityManager } from '../agent/identity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

function parseSkillMd(raw: string): { name?: string; version?: string; body: string } {
  if (!raw.startsWith('---\n')) return { body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return { body: raw };
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 5).trim();
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const version = fm.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  return { name, version, body };
}

export async function loadSkills(enabledSkills?: string[]): Promise<Skill[]> {
  let skillNames: string[];

  if (enabledSkills && enabledSkills.length > 0) {
    skillNames = enabledSkills;
    console.error(`[SkillLoader] Loading specified skills: ${skillNames.join(', ')}`);
  } else {
    if (!fs.existsSync(SKILLS_DIR)) {
      console.error('[SkillLoader] No skills/ directory — agent starts with no skills');
      return [];
    }
    skillNames = fs.readdirSync(SKILLS_DIR).filter(name =>
      fs.statSync(path.join(SKILLS_DIR, name)).isDirectory()
    );
    console.error(`[SkillLoader] Auto-discovered skills: ${skillNames.join(', ') || '(none)'}`);
  }

  const skills: Skill[] = [];

  for (const name of skillNames) {
    const skill = await tryLoadSkill(name);
    if (skill) skills.push(skill);
  }

  if (skills.length === 0) {
    console.error('[SkillLoader] Warning: no skills loaded — agent has no skill tools');
  }

  return skills;
}

export async function tryLoadSkill(name: string, baseDir = SKILLS_DIR): Promise<Skill | null> {
  const skillDir = path.join(baseDir, name);
  const entryJs = path.join(skillDir, 'src', 'index.js');
  const entryTs = path.join(skillDir, 'src', 'index.ts');
  const entry = fs.existsSync(entryJs) ? entryJs : entryTs;

  if (!fs.existsSync(entry)) {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      console.error(`[SkillLoader] Skill "${name}" entry not found — skipping`);
      return null;
    }
    const raw = fs.readFileSync(skillMdPath, 'utf-8');
    if (!raw.trim()) {
      console.error(`[SkillLoader] Skill "${name}" SKILL.md is empty — skipping`);
      return null;
    }
    const { name: parsedName, version, body } = parseSkillMd(raw);
    const skillName = parsedName ?? name;
    const skill: Skill = {
      name: skillName,
      version: version ?? '1.0.0',
      tools: [],
      async execute() { throw new Error(`Skill "${skillName}" has no tools`); },
      systemPrompt: body,
    };
    console.error(`[SkillLoader] Loaded SKILL.md skill: ${skillName}`);
    return skill;
  }

  try {
    const mod = await import(entry);
    const skill = (mod.default ?? mod) as Skill;
    if (!skill?.name || !skill?.tools || typeof skill?.execute !== 'function') {
      console.error(`[SkillLoader] Skill "${name}" invalid shape — skipping`);
      return null;
    }
    console.error(`[SkillLoader] Loaded: ${skill.name} v${skill.version} (${skill.tools.length} tools)`);
    return skill;
  } catch (err) {
    console.error(`[SkillLoader] Failed to load skill "${name}": ${(err as Error).message}`);
    return null;
  }
}

export async function installSkillDeps(skillName: string): Promise<void> {
  const pkgPath = path.join(SKILLS_DIR, skillName, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  console.error(`[SkillLoader] Installing deps for skill "${skillName}"...`);
  try {
    await execFileAsync('npm', ['install', '--prefix', path.join(SKILLS_DIR, skillName)]);
    console.error(`[SkillLoader] Deps installed for "${skillName}"`);
  } catch (err) {
    console.error(`[SkillLoader] npm install failed for "${skillName}": ${(err as Error).message}`);
  }
}

/** Register a skill with the identity manager (updates capabilities[]). */
export function registerSkill(skill: Skill, identityManager: IdentityManager): void {
  identityManager.addCapability(skill.name);
}
