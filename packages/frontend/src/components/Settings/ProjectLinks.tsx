import { useTranslation } from "../../i18n/index.ts";

const REPOSITORY_URL = "https://github.com/uerban/ptn";

const PROJECT_LINKS = [
  {
    href: REPOSITORY_URL,
    key: "settings.source_code",
    fallback: "Source code",
  },
  {
    href: `${REPOSITORY_URL}/blob/main/LICENSE`,
    key: "settings.license",
    fallback: "License",
  },
  {
    href: `${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md`,
    key: "settings.third_party_notices",
    fallback: "Third-party notices",
  },
] as const;

export function ProjectLinks() {
  const { t } = useTranslation();

  return (
    <nav aria-label={t("settings.project_links", "Project links")} className="mt-2">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
        {PROJECT_LINKS.map(({ href, key, fallback }) => (
          <li key={href}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-fg-secondary transition-colors"
            >
              {t(key, fallback)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
