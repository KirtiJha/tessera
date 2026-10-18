import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";

export interface Me {
  user: { id: string; name: string; email: string; role: "owner" | "admin" | "approver" | "operator" | "viewer"; teamId: string | null; teamName: string | null };
  org: { id: string; name: string; slug: string };
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/api/auth/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  const signOut = useCallback(async () => {
    await api.post("/api/auth/signout");
    setMe(null);
  }, []);
  const value = useMemo(
    () => ({ me, loading, refresh, signOut, isAdmin: me ? me.user.role === "owner" || me.user.role === "admin" : false }),
    [me, loading, refresh, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
