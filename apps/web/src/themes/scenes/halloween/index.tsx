import { useEffect, useRef, useState } from "react";
import { Fog, Grain, MoonShafts, Wisps } from "./atmosphere";
import { Graveyard, STILL_LINE } from "./graveyard";
import { House, Ridge } from "./house";
import { H, Speech, StillContext, W } from "./kit";
import { Pumpkins } from "./pumpkin";
import { Bat, Cloud, CloudDefs, Moon, Sky } from "./sky";
import { Fence, Lantern, MidHill, Owl, Spider, Tree } from "./tree";
import "./halloween.css";

// A moonlit graveyard for the foot of the sidebar, drawn in one SVG. Back to
// front: sky, moon (a witch crosses it now and then), clouds and bats; the far
// ridge and the haunted house; the middle hill with its fence and dead tree;
// the graveyard; the pumpkins; then wisps, fog, moonlight and film grain.
//
// It is decoration first. Three things answer a click — a tombstone raises its
// ghost, the owl turns its head, the jack-o'-lantern cackles — and each
// reaction ends by itself. A click never takes focus from the terminal, and
// every animation pauses while the window is in the background.

/** True while the window is hidden or another app has focus. */
function useBackgrounded() {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const update = () => setAway(document.hidden || !document.hasFocus());
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return away;
}

/** `still` freezes the scene in a showcase pose, for static previews. */
export default function HalloweenScene({ still = false }: { still?: boolean }) {
  const away = useBackgrounded() && !still;
  const svg = useRef<SVGSVGElement>(null);
  // CSS animations pause through the class below; SMIL needs the DOM call.
  useEffect(() => {
    if (away) svg.current?.pauseAnimations();
    else svg.current?.unpauseAnimations();
  }, [away]);

  return (
    <StillContext.Provider value={still}>
      <svg
        ref={svg}
        className={`hs${away ? " paused" : ""}${still ? " still" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
        // Keep keyboard focus where it was (usually the terminal).
        onMouseDown={(e) => e.preventDefault()}
      >
        <CloudDefs />
        <Speech initial={still ? [STILL_LINE] : undefined}>
          <Sky />
          <Moon />
          <Cloud y={84} scale={1.25} duration={120} delay={-76} />
          <Cloud y={38} scale={0.8} duration={150} delay={-54} opacity={0.8} />
          <Cloud y={130} scale={1.1} duration={170} delay={-44} opacity={0.75} />
          <Bat x={70} y={30} scale={0.95} duration={17} delay={-6} />
          <Bat x={130} y={52} scale={0.75} duration={23} delay={-15} />
          <Bat x={40} y={96} scale={0.6} duration={29} delay={-22} />
          <Bat x={190} y={116} scale={0.5} duration={35} delay={-4} />
          <Ridge />
          <House />
          <MidHill />
          <Fence />
          <Tree />
          <Spider />
          <Lantern />
          <Owl />
          <MoonShafts />
          <Wisps />
          <Graveyard />
          <Pumpkins />
          <Fog />
          <Grain />
        </Speech>
      </svg>
    </StillContext.Provider>
  );
}
