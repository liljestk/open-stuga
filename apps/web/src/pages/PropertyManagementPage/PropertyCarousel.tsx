import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type UIEvent } from "react";
import { ArrowLeft, ArrowRight, Boxes, Building2, Clock3, Map as MapIcon, MapPin, Wrench } from "lucide-react";
import type { Property } from "@climate-twin/contracts";
import { StugubyMark } from "../../components/StugubyMark";
import type { ClimateState } from "../../domain";
import { useI18n } from "../../i18n";
import "./PropertyCarousel.css";

interface PropertyCarouselProps {
  properties: Property[];
  state: ClimateState;
  onOpenProperty: (propertyId: string) => void;
  propertyShareLabel: (property: Property) => string | null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function PropertyCarousel({
  properties,
  state,
  onOpenProperty,
  propertyShareLabel,
}: Readonly<PropertyCarouselProps>) {
  const { locale, t } = useI18n();
  const carouselId = useId();
  const trackRef = useRef<HTMLOListElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const activeIndex = Math.min(selectedIndex, Math.max(0, properties.length - 1));
  const activeProperty = properties[activeIndex];
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );
  const propertyCounts = useMemo(() => {
    const counts = new globalThis.Map<string, { homes: number; areas: number; equipment: number; maintenance: number }>();
    properties.forEach((property) => counts.set(property.id, { homes: 0, areas: 0, equipment: 0, maintenance: 0 }));
    state.houses.forEach((home) => { const count = counts.get(home.propertyId); if (count) count.homes += 1; });
    state.propertyAreas.forEach((area) => { const count = counts.get(area.propertyId); if (count) count.areas += 1; });
    state.areaEquipment.forEach((equipment) => { const count = counts.get(equipment.propertyId); if (count) count.equipment += 1; });
    state.maintenanceTasks.forEach((task) => {
      const count = counts.get(task.propertyId);
      if (count && task.status !== "verified" && task.status !== "cancelled") count.maintenance += 1;
    });
    return counts;
  }, [properties, state.areaEquipment, state.houses, state.maintenanceTasks, state.propertyAreas]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, properties.length - 1)));
  }, [properties.length]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  if (!activeProperty) return null;

  const revealProperty = (index: number) => {
    const nextIndex = Math.max(0, Math.min(properties.length - 1, index));
    setSelectedIndex(nextIndex);
    window.requestAnimationFrame(() => {
      const track = trackRef.current;
      const slide = track?.children.item(nextIndex) as HTMLElement | null;
      if (!track || !slide || typeof track.scrollTo !== "function") return;
      const trackRect = track.getBoundingClientRect();
      const slideRect = slide.getBoundingClientRect();
      const centeredLeft = track.scrollLeft + slideRect.left - trackRect.left
        - (trackRect.width - slideRect.width) / 2;
      track.scrollTo({
        left: Math.max(0, centeredLeft),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
  };

  const updateSelectionFromScroll = (event: UIEvent<HTMLOListElement>) => {
    const track = event.currentTarget;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (trackRef.current !== track || track.children.length === 0) return;
      const viewportCenter = track.scrollLeft + track.clientWidth / 2;
      let lower = 0;
      let upper = track.children.length - 1;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        const slide = track.children.item(middle) as HTMLElement;
        const center = slide.offsetLeft + slide.offsetWidth / 2;
        if (center < viewportCenter) lower = middle + 1;
        else upper = middle;
      }
      const right = track.children.item(lower) as HTMLElement;
      const left = lower > 0 ? track.children.item(lower - 1) as HTMLElement : null;
      const rightDistance = Math.abs(right.offsetLeft + right.offsetWidth / 2 - viewportCenter);
      const leftDistance = left
        ? Math.abs(left.offsetLeft + left.offsetWidth / 2 - viewportCenter)
        : Number.POSITIVE_INFINITY;
      const closestIndex = leftDistance <= rightDistance ? lower - 1 : lower;
      setSelectedIndex((current) => current === closestIndex ? current : closestIndex);
    });
  };

  const navigateTrack = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      revealProperty(activeIndex - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      revealProperty(activeIndex + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      revealProperty(0);
    } else if (event.key === "End") {
      event.preventDefault();
      revealProperty(properties.length - 1);
    }
  };

  return <section className="property-carousel" aria-labelledby={`${carouselId}-title`}>
    <div className="property-carousel-header">
      <div>
        <h2 id={`${carouselId}-title`}>{t("properties.browseProperties")}</h2>
        <p id={`${carouselId}-help`}>{t("properties.carouselHelp")}</p>
      </div>
      <div className="property-carousel-controls">
        {properties.length > 1 && <label className="property-carousel-picker">
          <span>{t("properties.jumpToProperty")}</span>
          <select
            value={activeProperty.id}
            onChange={(event) => revealProperty(properties.findIndex((item) => item.id === event.target.value))}
          >
            {properties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        <div className="property-carousel-navigation">
          <button
            type="button"
            className="icon-button property-carousel-arrow"
            aria-label={t("properties.previousProperty")}
            aria-controls={`${carouselId}-track`}
            disabled={activeIndex === 0}
            onClick={() => revealProperty(activeIndex - 1)}
          ><ArrowLeft size={18} aria-hidden="true" /></button>
          <output aria-live="polite">{t("properties.carouselPosition", { current: activeIndex + 1, count: properties.length })}</output>
          <button
            type="button"
            className="icon-button property-carousel-arrow"
            aria-label={t("properties.nextProperty")}
            aria-controls={`${carouselId}-track`}
            disabled={activeIndex === properties.length - 1}
            onClick={() => revealProperty(activeIndex + 1)}
          ><ArrowRight size={18} aria-hidden="true" /></button>
        </div>
      </div>
    </div>

    <ol
      ref={trackRef}
      id={`${carouselId}-track`}
      className={`property-carousel-track${properties.length === 1 ? " is-single" : ""}`}
      aria-describedby={`${carouselId}-help`}
      tabIndex={properties.length > 1 ? 0 : -1}
      onKeyDown={navigateTrack}
      onScroll={updateSelectionFromScroll}
    >
      {properties.map((item, index) => {
        const counts = propertyCounts.get(item.id)!;
        const shareLabel = propertyShareLabel(item);
        const active = index === activeIndex;
        const facts = [
          { icon: Building2, label: t("properties.houses"), value: counts.homes },
          { icon: MapIcon, label: t("properties.areas"), value: counts.areas },
          { icon: Boxes, label: t("properties.inventory"), value: counts.equipment },
          { icon: Wrench, label: t("nav.maintenance"), value: counts.maintenance },
        ];
        return <li key={item.id} aria-current={active ? "true" : undefined} onFocus={() => setSelectedIndex(index)}>
          <article className={`panel property-index-card${item.stuguby ? " stuguby-shared" : ""}`} data-active={active}>
            <header>
              <span className="property-index-icon" aria-hidden="true">
                {item.stuguby ? <StugubyMark className="small" /> : <MapPin size={21} />}
              </span>
              <div>
                <h3>{item.name}</h3>
                {shareLabel && <span className="property-stuguby-label">{shareLabel}</span>}
              </div>
            </header>
            <p className={`property-index-description${item.description ? "" : " is-empty"}`}>
              {item.description || t("properties.noDescription")}
            </p>
            <dl className="property-index-facts">
              {facts.map(({ icon: Icon, label, value }) => <div key={label}>
                <dt><Icon size={15} aria-hidden="true" />{label}</dt>
                <dd>{value}</dd>
              </div>)}
            </dl>
            <div className="property-index-meta">
              {item.location?.label && <span><MapPin size={14} aria-hidden="true" />{item.location.label}</span>}
              <time dateTime={item.updatedAt}><Clock3 size={14} aria-hidden="true" />{t("properties.updated", { date: dateFormatter.format(new Date(item.updatedAt)) })}</time>
            </div>
            <button type="button" className="primary-button" onClick={() => onOpenProperty(item.id)}>
              {t("properties.openProperty", { property: item.name })}<ArrowRight size={16} aria-hidden="true" />
            </button>
          </article>
        </li>;
      })}
    </ol>
  </section>;
}
