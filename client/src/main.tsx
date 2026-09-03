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
      defaultColorScheme="light"
      theme={{
        primaryColor: "ink",
        primaryShade: 8,
        defaultRadius: "md",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        headings: {
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontWeight: "680",
        },
        colors: {
          ink: [
            "#f7f7f8",
            "#ededf0",
            "#d8d9de",
            "#b8bac2",
            "#8b8e99",
            "#646772",
            "#42454e",
            "#24262c",
            "#17181c",
            "#0d0e10",
          ],
          gold: [
            "#fff9e8",
            "#fdf0c4",
            "#f9dfa0",
            "#f1c96f",
            "#e7ae3c",
            "#d59622",
            "#b87816",
            "#8f5c12",
            "#67420f",
            "#3f290b",
          ],
        },
      }}
    >
      <Notifications position="bottom-right" />
      <App />
    </MantineProvider>
  </React.StrictMode>
);
