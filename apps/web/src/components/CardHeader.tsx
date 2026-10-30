import type { ReactNode } from "react";

interface CardHeaderProps {
  title: ReactNode;
  /** Context the title does not already give, such as the Home it belongs to. Leave it out otherwise. */
  eyebrow?: ReactNode;
  titleId?: string;
  level?: 2 | 3;
  /** One trailing icon, badge or action. */
  aside?: ReactNode;
  className?: string;
}

/** The heading row of a `.panel` card: an optional eyebrow, the title, and one aside. */
export function CardHeader({ title, eyebrow, titleId, level = 2, aside, className = "" }: Readonly<CardHeaderProps>) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={`panel-header ${className}`.trim()}>
      <div>
        {eyebrow !== undefined && <span className="eyebrow">{eyebrow}</span>}
        <Heading id={titleId}>{title}</Heading>
      </div>
      {aside}
    </div>
  );
}
