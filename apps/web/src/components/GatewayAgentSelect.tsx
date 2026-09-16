import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown } from "lucide-react";
import { DEFAULT_AGENTS } from "../agents";
import type { GatewayAgent } from "../modelGateway";
import { AgentLogo } from "./AgentLogo";

export function GatewayAgentLogo({ agent, id }: { agent?: GatewayAgent; id?: string }) {
  const icon = agent?.icon || DEFAULT_AGENTS.find((entry) => entry.id === (agent?.id ?? id))?.icon;
  return <span className="gateway-agent-logo" aria-hidden="true">{icon ? <AgentLogo src={icon} /> : <Bot size={18} />}</span>;
}

export function GatewayAgentSelect({ agents, value, label, placeholder, unavailable, disabled, onChange }: {
  agents: GatewayAgent[];
  value: string;
  label: string;
  placeholder: string;
  unavailable: string;
  disabled: boolean;
  onChange: (agent: GatewayAgent) => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 320 });
  const selected = agents.find((agent) => agent.id === value);
  const search = useRef({ text: "", time: 0 });

  function show() {
    setActive(Math.max(0, agents.findIndex((agent) => agent.id === value)));
    setOpen(true);
  }
  function choose(agent: GatewayAgent) {
    onChange(agent);
    setOpen(false);
    button.current?.focus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = button.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const height = Math.min(320, Math.max(below, above), agents.length * 38 + 10);
      setPosition({ left: rect.left, width: rect.width, top: below >= height ? rect.bottom + 4 : rect.top - height - 4, maxHeight: height });
    };
    update();
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) update(); };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", scroll, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", scroll, true); };
  }, [open, agents.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open) menu.current?.querySelector(`#${CSS.escape(id)}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  return <>
    <button ref={button} type="button" className="gateway-agent-select" role="combobox" aria-label={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && agents[active] ? `${id}-option-${active}` : undefined}
      disabled={disabled || !agents.length} onClick={() => open ? setOpen(false) : show()} onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!open) show();
          else setActive((current) => event.key === "Home" ? 0 : event.key === "End" ? agents.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + agents.length) % agents.length);
        } else if ((event.key === "Enter" || event.key === " ") && open) {
          event.preventDefault();
          if (agents[active]) choose(agents[active]);
        } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          search.current = { text: (Date.now() - search.current.time < 700 ? search.current.text : "") + event.key.toLowerCase(), time: Date.now() };
          const match = agents.findIndex((agent) => agent.name.toLowerCase().startsWith(search.current.text));
          if (!open) show();
          if (match >= 0) setActive(match);
        }
      }}>
      {value && <GatewayAgentLogo agent={selected} id={value} />}
      <span className="gateway-agent-select-name">{selected?.name ?? (value ? unavailable : placeholder)}</span><ChevronDown size={15} />
    </button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className="gateway-agent-menu" style={position}
      onMouseDown={(event) => event.preventDefault()} onClick={(event) => event.stopPropagation()}>
      {agents.map((agent, index) => <div key={agent.id} id={`${id}-option-${index}`} role="option" aria-selected={agent.id === value}
        className={`gateway-agent-option${active === index ? " active" : ""}`} onMouseMove={() => setActive(index)} onClick={() => choose(agent)}>
        <GatewayAgentLogo agent={agent} /><span className="gateway-agent-select-name">{agent.name}</span>{agent.id === value && <Check size={15} />}
      </div>)}
    </div>, document.body)}
  </>;
}
