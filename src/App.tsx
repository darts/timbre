import { useEffect } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { Mic, Library as LibIcon, Settings as Cog, AudioWaveform, Loader2, Package } from "lucide-react";
import { useBackendStatus } from "@/lib/queries";
import { useSidecar } from "@/lib/sidecar";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: backend, isLoading } = useBackendStatus();
  const { ensureRunning } = useSidecar();

  useEffect(() => {
    if (isLoading) return;
    if (!backend?.installed) {
      if (location.pathname !== "/first-run") {
        navigate("/first-run", { replace: true });
      }
    } else {
      ensureRunning();
    }
  }, [backend?.installed, isLoading, location.pathname, navigate, ensureRunning]);

  if (isLoading) {
    return (
      <div className="h-full grid place-items-center">
        <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
      </div>
    );
  }

  // Hide the app chrome (sidebar) until the backend is installed — during
  // FirstRun the install card should be the only thing on screen.
  const showChrome = backend?.installed === true;

  return (
    <div className="h-full flex">
      {showChrome && <Sidebar />}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-zinc-800/80 px-3 py-5 flex flex-col gap-1">
      <div className="px-2 mb-5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-indigo-500 to-fuchsia-500 grid place-items-center">
            <AudioWaveform className="w-4 h-4 text-white" />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight">Timbre</div>
            <div className="text-[11px] text-zinc-500">on-device voice cloning</div>
          </div>
        </div>
      </div>
      <NavItem to="/studio" icon={<Mic className="w-4 h-4" />} label="Studio" />
      <NavItem to="/library" icon={<LibIcon className="w-4 h-4" />} label="Voices" />
      <NavItem to="/models" icon={<Package className="w-4 h-4" />} label="Models" />
      <NavItem to="/settings" icon={<Cog className="w-4 h-4" />} label="Settings" />
    </aside>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
          isActive
            ? "bg-zinc-800/80 text-zinc-100"
            : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/40"
        }`
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
