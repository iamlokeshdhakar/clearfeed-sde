import type { Metadata } from "next";
import { Geist_Mono, Poppins } from "next/font/google";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ClearFeed | Support Ticket Assignment Automation",
  description:
    "Automated support ticket routing and availability management platform by ClearFeed",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${geistMono.variable} ${poppins.className} h-full antialiased`}
    >
      <body
        className={`${poppins.className} font-sans min-h-full flex flex-col bg-background text-foreground selection:bg-primary/20 selection:text-primary`}
      >
        {children}
      </body>
    </html>
  );
}
