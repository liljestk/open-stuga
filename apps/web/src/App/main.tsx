import { useAppPart01 } from "./part-01";
import { useAppPart02 } from "./part-02";
import { useAppPart03 } from "./part-03";
import { renderApp } from "./render";

export function App() {
  const context0 = {  };
  const context1 = useAppPart01(context0);
  const context2 = useAppPart02(context1);
  const context3 = useAppPart03(context2);
  return renderApp(context3);
}
