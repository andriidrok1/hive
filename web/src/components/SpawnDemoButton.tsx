import { useEffect, useRef, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { spawnDemoAgents, type SpawnPhase } from "../demoPresets";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface Props {
  size?: "sm" | "lg" | "default";
  className?: string;
  agentsRunning: boolean; // an agent for the current human is running: no reset, button disabled
}

// Every recording take starts from a clean project: reset, then Alex and Nika.
export function SpawnDemoButton({ size = "sm", className, agentsRunning }: Props) {
  const [phase, setPhase] = useState<SpawnPhase>("idle");
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async () => {
    if (phase !== "idle" || agentsRunning) return;
    setErr(null);
    try {
      await spawnDemoAgents({ onPhase: (p) => alive.current && setPhase(p) });
    } catch (e) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setPhase("idle");
    }
  };

  const label = phase === "resetting" ? "Resetting project…" : phase === "starting" ? "Starting agents…" : "Spawn demo agents";
  const busy = phase !== "idle";
  const button = (
    <Button
      size={size}
      className={className}
      disabled={busy || agentsRunning}
      aria-disabled={busy || agentsRunning || undefined}
      title={agentsRunning ? "Agents are running" : "Resets the project, then starts agent-alex now and agent-nika 3 s later"}
      onClick={() => void run()}
      data-phase={phase}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Users />}
      {label}
    </Button>
  );

  return (
    <>
      {agentsRunning ? (
        <Tooltip>
          {/* A disabled button does not fire pointer events; the span carries the tooltip. */}
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={0}>
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Agents are running</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {err && <span className="text-xs text-red-400">{err}</span>}
    </>
  );
}
