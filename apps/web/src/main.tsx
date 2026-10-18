import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Spinner, ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { Invite, SignIn, SignUp } from "./pages/Auth";
import { Landing } from "./pages/Landing";
import { Account, Audit, Prices } from "./pages/app/Admin";
import { Notifications } from "./pages/app/Notifications";
import { Budgets } from "./pages/app/Budgets";
import { Compare } from "./pages/app/Compare";
import { Devices } from "./pages/app/Devices";
import { History } from "./pages/app/History";
import { People } from "./pages/app/People";
import { Policies } from "./pages/app/Policies";
import { SessionPage } from "./pages/app/Session";
import { Sso } from "./pages/app/Sso";
import { Shell } from "./pages/app/Shell";
import { Spend } from "./pages/app/Spend";
import { Wall } from "./pages/app/Wall";
import "./styles.css";

function RequireAuth() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="flex h-full items-center justify-center bg-ink"><Spinner /></div>;
  if (!me) return <Navigate to="/signin" replace state={{ from: loc.pathname }} />;
  return <Outlet />;
}

function RequireAdmin() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Outlet /> : <Navigate to="/app" replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route element={<RequireAuth />}>
        <Route path="/app" element={<Shell />}>
          <Route index element={<Wall />} />
          <Route path="sessions/:id" element={<SessionPage />} />
          <Route path="history" element={<History />} />
          <Route path="spend" element={<Spend />} />
          <Route path="compare" element={<Compare />} />
          <Route path="devices" element={<Devices />} />
          <Route path="settings" element={<Account />} />
          <Route element={<RequireAdmin />}>
            <Route path="people" element={<People />} />
            <Route path="budgets" element={<Budgets />} />
            <Route path="policies" element={<Policies />} />
            <Route path="prices" element={<Prices />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="audit" element={<Audit />} />
            <Route path="sso" element={<Sso />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
