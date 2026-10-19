import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/header";
import type { BrandingConfig } from "@/lib/branding";

// The header reads branding from the cached /config.json, so the whole file
// mocks that module - the unbranded cases live in header.test.tsx.
const { branding } = vi.hoisted(() => ({ branding: { value: {} as BrandingConfig } }));

vi.mock("@/lib/branding", () => ({
  getBranding: () => branding.value,
}));

function renderWithRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

beforeEach(() => {
  branding.value = {};
});

describe("Header branding", () => {
  it("uses the bundled logos when no branding is configured", () => {
    renderWithRouter(<Header />);

    // One logo, picked from the theme the header is told about (no dark: CSS).
    const light = screen.getByRole("img", { name: "Nebari" });
    const lightSrc = light.getAttribute("src");
    expect(screen.getAllByRole("img")).toHaveLength(1);
    cleanup();

    renderWithRouter(<Header isDarkMode />);
    expect(screen.getByRole("img", { name: "Nebari" }).getAttribute("src")).not.toBe(lightSrc);
  });

  it("renders the branded logo and uses the title as its alt text", () => {
    branding.value = { title: "Acme Apps", logoUrl: "https://cdn.acme.example/logo.svg" };

    renderWithRouter(<Header />);

    const logo = screen.getByRole("img", { name: "Acme Apps" });
    expect(logo).toHaveAttribute("src", "https://cdn.acme.example/logo.svg");
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("prefers the dark logo in dark mode", () => {
    branding.value = {
      logoUrl: "https://cdn.acme.example/logo.svg",
      logoUrlDark: "https://cdn.acme.example/logo-dark.svg",
    };

    renderWithRouter(<Header isDarkMode />);

    expect(screen.getByRole("img", { name: "Nebari" })).toHaveAttribute(
      "src",
      "https://cdn.acme.example/logo-dark.svg",
    );
  });

  it("falls back to the light branded logo in dark mode when no dark logo is set", () => {
    branding.value = { logoUrl: "https://cdn.acme.example/logo.svg" };

    renderWithRouter(<Header isDarkMode />);

    expect(screen.getByRole("img", { name: "Nebari" })).toHaveAttribute(
      "src",
      "https://cdn.acme.example/logo.svg",
    );
  });
});
