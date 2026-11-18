"use client";

import { useEffect, useState } from "react";
import { useBrandRawFetch } from "@/components/brand/brand-fetch";
import { ConfirmDestructive } from "@/components/confirm-destructive";
import { getErrorMessage } from "@/components/experience/client-utils";
import { discardUnsavedChanges, useAnyUnsavedChanges } from "@/hooks/use-unsaved-changes";

type BrandOption = {
  id: string;
  name: string;
  slug: string;
  membershipRole: "ADMIN" | "MANAGER" | "VIEWER";
};

export function BrandSelector() {
  const brandFetch = useBrandRawFetch();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [activeBrandId, setActiveBrandId] = useState("");
  const [selectionRequired, setSelectionRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBrandId, setPendingBrandId] = useState<string | null>(null);
  const hasUnsavedChanges = useAnyUnsavedChanges();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/brand/context", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const json = (await response.json()) as {
          data?: {
            brands?: BrandOption[];
            activeBrandId?: string | null;
            selectionRequired?: boolean;
          };
        };
        if (!cancelled) {
          setBrands(json.data?.brands || []);
          setActiveBrandId(json.data?.activeBrandId || "");
          setSelectionRequired(Boolean(json.data?.selectionRequired));
        }
        return json;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  if (brands.length <= 1 && !selectionRequired) return null;

  async function switchBrand(brandId: string) {
    if (!brandId || brandId === activeBrandId) return;
    setSaving(true);
    setError(null);
    try {
      const response = await brandFetch("/api/brand/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      if (!response.ok) throw new Error("Brand selection failed");
      // The user already agreed to discard (or nothing was dirty): skip the beforeunload prompt.
      discardUnsavedChanges();
      // Page filters (own campaign, batch and similar ids) belong to the previous brand: drop them.
      window.history?.replaceState?.(null, "", window.location.pathname);
      window.location.reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not switch brands. Please try again."));
    } finally {
      setSaving(false);
    }
  }

  function requestSwitch(brandId: string) {
    if (!brandId || brandId === activeBrandId) return;
    if (hasUnsavedChanges) setPendingBrandId(brandId);
    else void switchBrand(brandId);
  }

  const pendingBrandName = brands.find((brand) => brand.id === pendingBrandId)?.name;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-edge/10 bg-glass-5 px-4 py-3">
      <label htmlFor="active-brand" className="text-sm font-medium text-copy-70">
        Active brand
      </label>
      <select
        id="active-brand"
        value={activeBrandId}
        disabled={saving}
        onChange={(event) => requestSwitch(event.target.value)}
        className="min-w-48 rounded-xl border border-edge/15 bg-inset/20 px-3 py-2 text-sm text-ink outline-none focus:border-edge/40"
      >
        <option value="" disabled>
          Select a brand
        </option>
        {brands.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.name}
          </option>
        ))}
      </select>
      {selectionRequired ? (
        <span className="text-xs text-amber-700 dark:text-amber-200">Choose a brand to continue.</span>
      ) : null}
      {error ? <span className="text-xs text-red-700 dark:text-red-200">{error}</span> : null}
      <ConfirmDestructive
        open={pendingBrandId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingBrandId(null);
        }}
        title="Discard unsaved changes?"
        description={`You have unsaved edits on this page. Switching${pendingBrandName ? ` to ${pendingBrandName}` : " brands"} reloads the page and discards them.`}
        confirmLabel="Discard and switch"
        onConfirm={() => {
          const brandId = pendingBrandId;
          setPendingBrandId(null);
          if (brandId) return switchBrand(brandId);
        }}
      />
    </div>
  );
}
