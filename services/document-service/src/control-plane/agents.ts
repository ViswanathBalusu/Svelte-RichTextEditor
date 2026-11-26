/**
 * The agent registry (05 §3.2.1; ADR 0234 A2; UX-046 criterion 6): the assistants a tenant has
 * registered, each with a display name, the owning service credential and, optionally, the
 * documents it may act on. An agent token is honoured only for an agent that is registered here,
 * enabled, and allowed on the document.
 *
 * This is the in-process registry. A deployment that must keep agents across a restart supplies
 * another implementation of `AgentRegistry`; none is built (see the notes of UX-046).
 */
import { randomUUID } from 'node:crypto';

/** One registered agent. `documents` null means every document of the tenant. */
export interface AgentRecord {
  readonly id: string;
  readonly tenant: string;
  /** What history and the review pane show, for example the model's name. */
  readonly name: string;
  /** The service credential that registered it (`ServiceIdentity.credential`). */
  readonly owner: string;
  readonly documents: readonly string[] | null;
  readonly enabled: boolean;
}

export interface AgentRegistry {
  register(
    tenant: string,
    input: { name: string; owner: string; documents?: readonly string[] },
  ): Promise<AgentRecord>;
  get(tenant: string, id: string): Promise<AgentRecord | undefined>;
  /** Disables an agent: its tokens stop verifying at once. Returns false for an unknown agent. */
  disable(tenant: string, id: string): Promise<boolean>;
}

export class MemoryAgentRegistry implements AgentRegistry {
  readonly #agents = new Map<string, AgentRecord>();

  async register(
    tenant: string,
    input: { name: string; owner: string; documents?: readonly string[] },
  ): Promise<AgentRecord> {
    const record: AgentRecord = {
      id: `agt_${randomUUID()}`,
      tenant,
      name: input.name,
      owner: input.owner,
      documents: input.documents === undefined ? null : [...input.documents],
      enabled: true,
    };
    this.#agents.set(`${tenant}/${record.id}`, record);
    return record;
  }

  async get(tenant: string, id: string): Promise<AgentRecord | undefined> {
    return this.#agents.get(`${tenant}/${id}`);
  }

  async disable(tenant: string, id: string): Promise<boolean> {
    const known = this.#agents.get(`${tenant}/${id}`);
    if (known === undefined) return false;
    this.#agents.set(`${tenant}/${id}`, { ...known, enabled: false });
    return true;
  }
}

/** Whether `agent` may act on `doc`. */
export function agentMayActOn(agent: AgentRecord, doc: string): boolean {
  return agent.enabled && (agent.documents === null || agent.documents.includes(doc));
}
