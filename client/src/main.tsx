import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import App from "./App";

import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MantineProvider
      defaultColorScheme="dark"
      theme={{
        primaryColor: "gold",
        primaryShade: 5,
        defaultRadius: "md",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        headings: {
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontWeight: "760",
        },
        colors: {
          gold: [
            "#fff8e1",
            "#ffefc2",
            "#ffdf85",
            "#ffd04d",
            "#ffc52a",
            "#f6b810",
            "#d99b00",
            "#ac7800",
            "#7e5700",
            "#513700",
          ],
        },
      }}
    >
      <Notifications />
      <App />
    </MantineProvider>
  </React.StrictMode>
);
