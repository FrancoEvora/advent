"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import s from "./solaris-magazine.module.css";

type AmenityGroup = {
  title: string;
  text: string;
  items: [string, string | null][];
};

const PHOTOS = "/forms/solaris/editorial";
const officialImages: Record<string, string> = {
  "04_piscinas_adulto_infantil": `${PHOTOS}/piscina-convivencia-v7.webp`,
  "07_tenis_beach_tennis": `${PHOTOS}/beach-tennis-v7.webp`,
  "12_brinquedoteca": `${PHOTOS}/brinquedoteca-v7.webp`,
};

export function SolarisLeisureCarousel({ groups }: { groups: AmenityGroup[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const slides = groups.flatMap((group, groupIndex) =>
    group.items.flatMap(([title, image]) => image ? [{ title, image, group: group.title, groupIndex }] : []),
  );
  const currentGroup = groups[slides[active]?.groupIndex ?? 0];

  function goTo(index: number) {
    const next = Math.max(0, Math.min(slides.length - 1, index));
    const container = track.current;
    const slide = container?.children.item(next) as HTMLElement | null;
    if (container && slide) container.scrollTo({ left: slide.offsetLeft - container.offsetLeft, behavior: "smooth" });
    setActive(next);
  }

  function onScroll() {
    const container = track.current;
    if (!container) return;
    const cards = Array.from(container.children) as HTMLElement[];
    const nearest = cards.reduce((result, card, index) =>
      Math.abs(card.offsetLeft - container.offsetLeft - container.scrollLeft) < Math.abs(cards[result].offsetLeft - container.offsetLeft - container.scrollLeft) ? index : result, 0);
    setActive(nearest);
  }

  return <div className={s.leisureCarousel} aria-label="Galeria dos espaços de lazer do Solaris">
    <div className={s.leisureControls}>
      <div>
        <p className={s.kicker}>EXPLORE OS ESPAÇOS DO SOLARIS</p>
        <p className={s.leisureDescription}>{currentGroup.text}</p>
      </div>
      <div className={s.leisureArrows} aria-label="Navegar pelas imagens de lazer">
        <span aria-live="polite">{String(active + 1).padStart(2, "0")} <span>/ {String(slides.length).padStart(2, "0")}</span></span>
        <button type="button" onClick={() => goTo(active - 1)} disabled={active === 0} aria-label="Imagem anterior">←</button>
        <button type="button" onClick={() => goTo(active + 1)} disabled={active === slides.length - 1} aria-label="Próxima imagem">→</button>
      </div>
    </div>
    <div className={s.leisureCategories} aria-label="Selecionar categoria de lazer">
      {groups.map((group, index) => <button key={group.title} type="button" aria-pressed={slides[active]?.groupIndex === index} onClick={() => goTo(slides.findIndex(slide => slide.groupIndex === index))}>{group.title}</button>)}
    </div>
    <div className={s.leisureTrack} ref={track} onScroll={onScroll} tabIndex={0} role="region" aria-label="Imagens de lazer, deslize para os lados">
      {slides.map((slide, index) => {
        const original = officialImages[slide.image];
        return <article className={s.leisureSlide} key={slide.image}>
          <div className={s.leisurePhoto}>
            <Image src={original || `${PHOTOS}/lazer/${slide.image}.webp`} alt={`Imagem ilustrativa de ${slide.title.toLowerCase()} no Solaris.`} width={1200} height={900} unoptimized loading="lazy" className={original ? s.leisureOfficial : s.leisureConcept} />
          </div>
          <div className={s.leisureSlideInfo}><span>{slide.group} · {String(index + 1).padStart(2, "0")}</span><h3>{slide.title}</h3><p>Perspectiva ilustrativa · Equipamento previsto em projeto</p></div>
        </article>;
      })}
    </div>
    <div className={s.leisureFooter}><span>Deslize para explorar os espaços <span aria-hidden="true">→</span></span><span>Acessibilidade prevista no projeto. Consulte o memorial e as condições de acesso ao Centro Hípico.</span></div>
  </div>;
}
