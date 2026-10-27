import "../StugubyPage.css";
import type { StugubyPageProps } from "./support";
import { useStugubyPagePart01 } from "./part-01";
import { useStugubyPagePart02 } from "./part-02";
import { useStugubyPagePart03 } from "./part-03";
import { renderStugubyPage } from "./render";

export function StugubyPage({ houses, properties = [], onInventoryChange }: Readonly<StugubyPageProps>) {
  const context0 = { houses, properties, onInventoryChange };
  const context1 = useStugubyPagePart01(context0);
  const context2 = useStugubyPagePart02(context1);
  const context3 = useStugubyPagePart03(context2);
  return renderStugubyPage(context3);
}
