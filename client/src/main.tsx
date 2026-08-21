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
        primaryColor: "yellow",
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        headings: {
          fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          fontWeight: "800",
        },
        defaultRadius: "md",
        cursorType: "pointer",
        colors: {
          yellow: [
            "#fffbe6",
            "#fff3bf",
            "#ffe58a",
            "#ffd24d",
            "#f7bd22",
            "#e7a909",
            "#c98900",
            "#9f6800",
            "#754b00",
            "#4d3000"
          ]
        }
      }}
    >
      <Notifications />
      <App />
    </MantineProvider>
  </React.StrictMode>
);
