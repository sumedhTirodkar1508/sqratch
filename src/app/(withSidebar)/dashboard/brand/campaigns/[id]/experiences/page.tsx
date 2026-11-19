"use client";

import { useBrandFetch } from "@/components/brand/brand-fetch";

import { useEffect, useRef, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ExperienceItem = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  status: "PUBLISHED" | "DRAFT";
  creatorName: string;
};

type AttachedItem = ExperienceItem & { sortOrder: number | null };

type SponsorshipResponse = {
  campaign: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isActive: boolean;
    brandId: string | null;
  };
  attached: AttachedItem[];
  discover: {
    items: ExperienceItem[];
    meta: { hasNextPage: boolean; nextCursor: string | null; limit: number };
  };
};

function ExperienceCard({
  experience,
  attached,
  saving,
  onToggle,
}: {
  experience: ExperienceItem;
  attached: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  const isDraft = experience.status === "DRAFT";
  return (
    <PageCard>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold">{experience.title}</h2>
            <span className="rounded-full border border-edge/10 px-3 py-1 text-xs text-copy-65">
              {isDraft ? "Draft" : "PUBLISHED"}
            </span>
            {attached && (
              <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-700 dark:text-emerald-200">
                Attached
              </span>
            )}
            {attached && isDraft && (
              <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-200">
                Hidden until republished
              </span>
            )}
          </div>
          <p className="mt-2 text-sm text-copy-55">
            /{experience.slug} · by {experience.creatorName}
          </p>
          {experience.description && (
            <p className="mt-3 text-sm leading-6 text-copy-70">
              {experience.description}
            </p>
          )}
        </div>

        <Button
          type="button"
          onClick={onToggle}
          disabled={saving}
          variant={attached ? "destructive" : undefined}
          className={
            attached
              ? "rounded-full border border-red-500/40 bg-red-500 text-white hover:bg-red-500/90"
              : "rounded-full border border-edge bg-primary text-primary-foreground"
          }
        >
          {saving ? "Saving..." : attached ? "Detach" : "Attach"}
        </Button>
      </div>
    </PageCard>
  );
}

export default function BrandCampaignExperiencesPage({
  params,
}: {
  params: { id: string };
}) {
  const campaignId = params.id;
  const brandFetch = useBrandFetch();
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SponsorshipResponse | null>(null);
  const [discoverItems, setDiscoverItems] = useState<ExperienceItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  async function loadExperiences(
    currentCampaignId: string,
    currentQuery: string,
    cursor?: string | null,
  ) {
    setError(null);
    const seq = ++requestSeq.current;

    try {
      const qs = new URLSearchParams();
      if (currentQuery.trim()) {
        qs.set("q", currentQuery.trim());
      }
      if (cursor) {
        qs.set("cursor", cursor);
      }

      const result = await fetchJson<SponsorshipResponse>(
        `/api/brand/campaigns/${currentCampaignId}/attach-experience?${qs.toString()}`,
      );
      if (seq !== requestSeq.current) return;
      if (cursor) {
        setDiscoverItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [
            ...current,
            ...result.discover.items.filter((item) => !seen.has(item.id)),
          ];
        });
      } else {
        setData(result);
        setDiscoverItems(result.discover.items);
      }
      setNextCursor(result.discover.meta.nextCursor);
    } catch (loadError) {
      if (seq !== requestSeq.current) return;
      setError(
        getErrorMessage(loadError, "Failed to load campaign experiences."),
      );
    }
  }

  useEffect(() => {
    void loadExperiences(campaignId, query);
  }, [campaignId, query]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      await loadExperiences(campaignId, query, nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggleExperience(experienceId: string, attach: boolean) {
    setSavingId(experienceId);
    setError(null);

    try {
      await brandFetch(`/api/brand/campaigns/${campaignId}/attach-experience`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          experienceId,
          attach,
        }),
      });
      await loadExperiences(campaignId, query);
    } catch (saveError) {
      setError(
        getErrorMessage(saveError, "Failed to update campaign sponsorships."),
      );
    } finally {
      setSavingId(null);
    }
  }

  return (
    <BrandPageShell
      title={data ? `${data.campaign.name} Sponsorships` : "Attach Experiences"}
      description="Attach or detach creator experiences for this campaign. An experience can belong to multiple campaigns."
    >
      {error && (
        <PageCard>
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </PageCard>
      )}

      {!data ? (
        <PageCard>
          <p className="text-sm text-copy-65">Loading experiences...</p>
        </PageCard>
      ) : (
        <div className="space-y-8">
          <section className="space-y-5">
            <h2 className="text-lg font-semibold">
              Attached to this campaign ({data.attached.length})
            </h2>
            {data.attached.length === 0 ? (
              <PageCard>
                <p className="text-sm text-copy-65">
                  No experiences are attached yet.
                </p>
              </PageCard>
            ) : (
              data.attached.map((experience) => (
                <ExperienceCard
                  key={experience.id}
                  experience={experience}
                  attached
                  saving={savingId === experience.id}
                  onToggle={() => void toggleExperience(experience.id, false)}
                />
              ))
            )}
          </section>

          <section className="space-y-5">
            <h2 className="text-lg font-semibold">Find experiences to attach</h2>
            <PageCard>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search published experiences by title or slug"
                className="border-edge/10 bg-inset/20 text-ink placeholder:text-copy-35"
              />
            </PageCard>
            {discoverItems.length === 0 ? (
              <PageCard>
                <p className="text-sm text-copy-65">
                  No other published experiences match.
                </p>
              </PageCard>
            ) : (
              discoverItems.map((experience) => (
                <ExperienceCard
                  key={experience.id}
                  experience={experience}
                  attached={false}
                  saving={savingId === experience.id}
                  onToggle={() => void toggleExperience(experience.id, true)}
                />
              ))
            )}
            {nextCursor && (
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            )}
          </section>
        </div>
      )}
    </BrandPageShell>
  );
}
