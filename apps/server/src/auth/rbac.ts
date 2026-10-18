export type Role = "owner" | "admin" | "approver" | "operator" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, operator: 1, approver: 2, admin: 3, owner: 4 };

export function atLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export interface Principal {
  userId: string;
  orgId: string;
  teamId: string | null;
  role: Role;
  name: string;
  email: string;
}

/** Can this principal act on (answer, approve, message) a session owned by `ownerId` in `teamId`? */
export function canActOn(p: Principal, session: { ownerId: string | null; teamId: string | null }): boolean {
  if (session.ownerId === p.userId) return atLeast(p.role, "operator");
  if (atLeast(p.role, "admin")) return true;
  if (p.role === "approver") return session.teamId !== null && session.teamId === p.teamId;
  return false;
}

export function canManageOrg(p: Principal): boolean {
  return atLeast(p.role, "admin");
}
