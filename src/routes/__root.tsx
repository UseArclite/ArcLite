import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Header } from "../app/components/chrome";
import { Immersion } from "../app/components/immersion";
import { LanguageProvider } from "../app/lib/i18n";
import { MarketProvider } from "../app/components/market-provider";
import { WalletProvider } from "../app/components/wallet-provider";
import { SessionProvider } from "../app/components/session-provider";
import { VaultProvider } from "../app/components/vault-provider";
import { SceneMotion } from "../app/components/scene-motion";
import { RouteTransition } from "../app/components/route-transition";
import globalStyles from "../app/globals.css?url";
import editorialStyles from "../app/editorial.css?url";
import interactiveStyles from "../app/interactive.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ArcLite — Private Execution. Real-World Value." },
      {
        name: "description",
        content:
          "A private market designed for tokenized stocks, treasury assets, sealed-batch crossing and public solvency proofs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "icon", type: "image/png", href: "/favicon.png?v=3" },
      ...[globalStyles, editorialStyles, interactiveStyles].map((href) => ({
        rel: "stylesheet",
        href,
      })),
    ],
  }),
  shellComponent: RootShell,
  component: Root,
  notFoundComponent: () => (
    <main className="article-body">
      <h1>Page not found.</h1>
      <a href="/">Return to ArcLite</a>
    </main>
  ),
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Root() {
  return (
    <Immersion>
      {/* WalletProvider sits inside MarketProvider because market data is public — prices,
          guards and the window clock render for anyone, and only balances need a wallet.
          MetaMask only. */}
      <LanguageProvider>
        <MarketProvider>
          <WalletProvider>
            {/* SessionProvider needs both the wallet (to sign) and the query client
              (to hold the session), so it sits inside WalletProvider. Signing in is
              always an explicit act — nothing here prompts for a signature. */}
            <SessionProvider>
              {/* VaultProvider holds no key material itself — it owns the worker that does.
                Unlocking is a third, separate prompt: connecting, signing in and opening
                the vault each grant something different. */}
              <VaultProvider>
                <Header />
                <Outlet />
                <SceneMotion />
                <RouteTransition />
              </VaultProvider>
            </SessionProvider>
          </WalletProvider>
        </MarketProvider>
      </LanguageProvider>
    </Immersion>
  );
}
