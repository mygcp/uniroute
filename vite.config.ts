import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

function forwardedHostPlugin(): Plugin {
  return {
    name: "uniroute-forwarded-host",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const remote = req.socket?.remoteAddress ?? "";
        const isLoopback =
          remote === "127.0.0.1" ||
          remote === "::1" ||
          remote === "::ffff:127.0.0.1";
        if (isLoopback) {
          const raw = req.headers["x-forwarded-host"];
          const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
          if (first && !/[\s/@\\?#]/.test(first)) {
            req.headers.host = first;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [forwardedHostPlugin(), tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react-router", "lucide-react"],
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                {
                  name: "icons",
                  test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
                  priority: 20,
                },
                {
                  name: "ui",
                  test: /[\\/]app[\\/](components|hooks|lib)[\\/]/,
                  priority: 10,
                },
              ],
            },
          },
        },
      },
    },
  },
  server: {
    allowedHosts: true,
  },
});
