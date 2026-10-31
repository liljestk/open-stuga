import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import { App } from "./App";
import { isAssistantConsentLocation } from "./assistantConnector";
import { ConfirmationProvider } from "./components/ConfirmationProvider";
import { AssistantConsentPage } from "./pages/AssistantConsentPage";
import { I18nProvider } from "./i18n";
import { ServerStateProvider } from "./data/queryClient";
import { startBugReportDiagnostics } from "./bugReportDiagnostics";
import "./styles.css";

startBugReportDiagnostics();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <ConfirmationProvider>
        <ServerStateProvider>
          {isAssistantConsentLocation(window.location) ? <AssistantConsentPage /> : <App />}
        </ServerStateProvider>
      </ConfirmationProvider>
    </I18nProvider>
  </React.StrictMode>,
);
