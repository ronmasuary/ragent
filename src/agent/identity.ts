import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface AgentIdentity {
  id: string;
  name: string;
  createdAt: string;
  capabilities: string[];
}

export class IdentityManager {
  private filePath: string;
  private identity: AgentIdentity;

  constructor(identityDir: string, agentName: string) {
    fs.mkdirSync(identityDir, { recursive: true });
    this.filePath = path.join(identityDir, 'identity.json');

    if (fs.existsSync(this.filePath)) {
      this.identity = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as AgentIdentity;
      if (this.identity.name !== agentName) {
        this.identity.name = agentName;
        this.save();
      }
    } else {
      this.identity = {
        id: uuidv4(),
        name: agentName,
        createdAt: new Date().toISOString(),
        capabilities: [],
      };
      this.save();
      console.error(`[Identity] Created new identity: ${this.identity.id} (${agentName})`);
    }
    console.error(`[Identity] Loaded: ${this.identity.name} (${this.identity.id})`);
  }

  get(): AgentIdentity {
    return { ...this.identity };
  }

  addCapability(cap: string): void {
    if (!this.identity.capabilities.includes(cap)) {
      this.identity.capabilities.push(cap);
      this.save();
      console.error(`[Identity] Capability added: ${cap}`);
    }
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.identity, null, 2), 'utf-8');
  }
}
