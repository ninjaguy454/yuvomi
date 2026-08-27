import { t } from '/i18n.js';
import { moduleAccentVar } from '/utils/module-accent.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { createRetryState } from './components.js';
import { clearLeafEdits, confirmLeafExit, watchLeafForms } from './dirty-guard.js';
import { resetPreferencesCache } from './preferences-cache.js';
import {
  SETTINGS_LEAVES,
  filterSettingsDomains,
  findSettingsLeaf,
  settingsOverviewUrl,
} from './registry.js';

// Unter dieser Schwelle ist ein Blatt gefuehlt sofort da; ein Skelett waere
// dort nur ein Aufblitzen.
const SKELETON_DELAY_MS = 120;

function createIcon(name, className) {
  const icon = document.createElement('i');
  icon.className = className;
  icon.dataset.lucide = name;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

/**
 * Das Zeichen eines Blattes in seiner Marke.
 *
 * WER EIN MODUL NENNT, TRAEGT SEINEN TON - die anderen bleiben neutral. Das ist
 * die Vollton-Regel (DESIGN.md, Colors) auf einer Flaeche, die vorher gar keine
 * Farbe hatte: neunundzwanzig Blaetter, neunundzwanzig graue Zeichen, obwohl
 * elf davon von einem Modul handeln, dessen Ton drei Klicks weiter in der
 * Seitenleiste als Legende steht. Die Gegenrichtung ist genauso Teil der Regel
 * und der Grund, warum hier nicht alles bunt wird: „Konto", „Darstellung" oder
 * „Backup" nennen kein Modul, also nennen sie auch keine Farbe.
 *
 * Die Zuordnung steht im `module`-Feld der Registry, nicht hier - sonst waere
 * es die zwoelfte Liste, die mit der Modulliste driften kann.
 *
 * @param {object} entry     Blatt aus SETTINGS_LEAVES
 * @param {string} className Klasse der Marke in ihrem Umfeld (Geometrie)
 * @returns {HTMLElement}
 */
function createLeafMark(entry, className) {
  const mark = document.createElement('span');
  mark.className = entry.module ? `${className} vivid-mark` : className;
  if (entry.module) mark.style.setProperty('--seal-accent', moduleAccentVar(entry.module));
  mark.setAttribute('aria-hidden', 'true');
  mark.appendChild(createIcon(entry.icon, `${className}-glyph`));
  return mark;
}

function hydrateIcons(container) {
  if (window.lucide) window.lucide.createIcons({ el: container });
}

function bindSpaNavigation(link, href) {
  link.addEventListener('click', async (event) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || !window.yuvomi?.navigate
    ) {
      return;
    }
    event.preventDefault();
    // Alle Wege aus einem Blatt heraus laufen ueber diese Links: Seitenleiste,
    // Suchtreffer, Breadcrumb und der Zurueck-Link.
    if (!(await confirmLeafExit())) return;
    window.yuvomi.navigate(href);
  });
}

function createLink(href, className) {
  const link = document.createElement('a');
  link.href = href;
  link.className = className;
  bindSpaNavigation(link, href);
  return link;
}

function allowedLeavesForDomain(domainId, user) {
  return SETTINGS_LEAVES.filter((entry) => (
    entry.domainId === domainId
    && (!entry.adminOnly || user?.role === 'admin')
  ));
}

let navPanelIdCounter = 0;

// Setzt den Auf-/Zu-Zustand einer Domänen-Gruppe konsistent über alle Träger:
// CSS-Klasse (treibt die Höhen-Animation), aria-expanded am Trigger und `inert`
// am Panel (nimmt kollabierte Links aus Tab-Reihenfolge und A11y-Baum).
function setGroupExpanded(group, expanded) {
  group.classList.toggle('settings-shell__navigation-group--expanded', expanded);
  const toggle = group.querySelector('.settings-shell__navigation-toggle');
  const panel = group.querySelector('.settings-shell__navigation-panel');
  if (toggle) toggle.setAttribute('aria-expanded', String(expanded));
  if (panel) panel.inert = !expanded;
}

function collapseAllGroups(navigation) {
  for (const open of navigation.querySelectorAll('.settings-shell__navigation-group--expanded')) {
    setGroupExpanded(open, false);
  }
}

function createDomainToggle(domain, panelId, expanded) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'settings-shell__navigation-toggle';
  toggle.setAttribute('aria-controls', panelId);
  toggle.setAttribute('aria-expanded', String(expanded));

  const label = document.createElement('span');
  label.className = 'settings-shell__navigation-domain-label';
  label.textContent = t(domain.labelKey);

  toggle.append(
    createIcon(domain.icon, 'settings-shell__navigation-domain-icon'),
    label,
    createIcon('chevron-down', 'settings-shell__navigation-chevron'),
  );
  return toggle;
}

// Vergleichsform für die Blatt-Suche: Diakritika weg, damit "wetter" auch
// "Wetter" findet und "prazdniny" auch "prázdniny".
function searchNormalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function createNavigationLink(entry, activeLeaf) {
  const link = createLink(entry.path, 'settings-shell__navigation-link');
  link.dataset.leafId = entry.id;
  link.append(
    createLeafMark(entry, 'settings-shell__navigation-link-icon'),
    document.createTextNode(t(entry.labelKey)),
  );
  if (entry.id === activeLeaf?.id) {
    link.classList.add('settings-shell__navigation-link--active');
    link.setAttribute('aria-current', 'page');
  }
  return link;
}

/**
 * Suchfeld über alle sichtbaren Blätter. Bei 23 Blättern in vier Domänen ist
 * die Taxonomie sonst der einzige Weg zu einer Einstellung, deren Domäne man
 * nicht kennt (Critique 2026-07-27). Gefiltert wird über Label UND Beschreibung,
 * damit "Zeitzone" auch ein Blatt findet, das anders heisst.
 */
function createNavigationSearch(navigation, domains, user, activeLeaf) {
  const leaves = domains.flatMap((domain) => allowedLeavesForDomain(domain.id, user)
    .map((entry) => ({
      entry,
      domainLabel: t(domain.labelKey),
      haystack: searchNormalize(`${t(entry.labelKey)} ${t(entry.descriptionKey)} ${t(domain.labelKey)}`),
    })));

  const field = document.createElement('div');
  field.className = 'settings-shell__navigation-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'form-input settings-shell__navigation-search-input';
  input.placeholder = t('settings.searchLabel');
  input.setAttribute('aria-label', t('settings.searchLabel'));
  field.appendChild(input);

  const results = document.createElement('ul');
  results.className = 'settings-shell__navigation-list settings-shell__navigation-results';
  results.hidden = true;

  const status = document.createElement('p');
  status.className = 'settings-shell__navigation-status';
  status.setAttribute('role', 'status');
  status.hidden = true;

  const groups = () => navigation.querySelectorAll('.settings-shell__navigation-group');

  const applyFilter = () => {
    const query = searchNormalize(input.value.trim());
    const searching = query.length > 0;

    for (const group of groups()) group.hidden = searching;
    results.hidden = !searching;
    status.hidden = !searching;

    if (!searching) {
      results.replaceChildren();
      status.textContent = '';
      return;
    }

    const hits = leaves.filter((leaf) => leaf.haystack.includes(query));
    results.replaceChildren(...hits.map(({ entry, domainLabel }) => {
      const item = document.createElement('li');
      const link = createLink(entry.path, 'settings-shell__navigation-link settings-shell__navigation-result');
      link.dataset.leafId = entry.id;
      if (entry.id === activeLeaf?.id) {
        link.classList.add('settings-shell__navigation-link--active');
        link.setAttribute('aria-current', 'page');
      }

      // Ohne die Gruppen fehlt der Ort: die Domäne wandert unter den Treffer.
      // Label und Domäne stehen zusammen in einer Spalte neben dem Icon, damit
      // ein langer Name nicht das Icon in eine eigene Zeile drängt.
      const text = document.createElement('span');
      text.className = 'settings-shell__navigation-result-text';
      const label = document.createElement('span');
      label.textContent = t(entry.labelKey);
      const domainHint = document.createElement('span');
      domainHint.className = 'settings-shell__navigation-result-domain';
      domainHint.textContent = domainLabel;
      text.append(label, domainHint);

      link.append(createLeafMark(entry, 'settings-shell__navigation-link-icon'), text);
      item.appendChild(link);
      return item;
    }));
    hydrateIcons(results);

    status.textContent = hits.length
      ? t('settings.searchResults', { count: hits.length })
      : t('search.noResults');
  };

  input.addEventListener('input', applyFilter);
  input.addEventListener('search', applyFilter);

  navigation.prepend(field, status, results);
}

function createNavigation(domains, user, activeLeaf) {
  const navigation = document.createElement('nav');
  navigation.className = 'settings-shell__navigation';
  navigation.setAttribute('aria-label', t('settings.navigationLabel'));

  // Eine einzelne Domäne (z. B. Familienmitglieder ohne Admin-Bereiche) braucht
  // kein Akkordeon — sie bleibt dauerhaft offen ohne Collapse-Affordance.
  const collapsible = domains.length > 1;
  navigation.classList.toggle('settings-shell__navigation--collapsible', collapsible);

  // Single-Open: genau die aktive Domäne ist offen. Ohne aktives Blatt bleibt
  // die Root eine echte Übersicht; die lokale Navigation zeigt nur Domänen.
  const expandedDomainId = activeLeaf?.domainId ?? null;

  for (const domain of domains) {
    const group = document.createElement('section');
    group.className = 'settings-shell__navigation-group';
    group.dataset.domainId = domain.id;
    if (domain.id === activeLeaf?.domainId) {
      group.classList.add('settings-shell__navigation-group--active');
    }

    const list = document.createElement('ul');
    list.className = 'settings-shell__navigation-list';
    for (const entry of allowedLeavesForDomain(domain.id, user)) {
      const item = document.createElement('li');
      item.appendChild(createNavigationLink(entry, activeLeaf));
      list.appendChild(item);
    }

    if (collapsible) {
      const expanded = domain.id === expandedDomainId;
      group.classList.toggle('settings-shell__navigation-group--expanded', expanded);

      const panelId = `settings-domain-panel-${++navPanelIdCounter}`;
      const heading = document.createElement('h2');
      heading.className = 'settings-shell__navigation-heading';
      const toggle = createDomainToggle(domain, panelId, expanded);
      heading.appendChild(toggle);

      const panel = document.createElement('div');
      panel.className = 'settings-shell__navigation-panel';
      panel.id = panelId;
      panel.inert = !expanded;
      panel.appendChild(list);

      toggle.addEventListener('click', () => {
        const willExpand = toggle.getAttribute('aria-expanded') !== 'true';
        if (willExpand) collapseAllGroups(navigation);
        setGroupExpanded(group, willExpand);
      });

      group.append(heading, panel);
    } else {
      const heading = document.createElement('h2');
      heading.className = 'settings-shell__navigation-heading';
      heading.append(
        createIcon(domain.icon, 'settings-shell__navigation-domain-icon'),
        document.createTextNode(t(domain.labelKey)),
      );
      group.append(heading, list);
    }

    navigation.appendChild(group);
  }

  createNavigationSearch(navigation, domains, user, activeLeaf);
  return navigation;
}

// Aktualisiert nur den Aktivzustand der bestehenden Navigation, ohne die Links
// (und ihre Icons) neu aufzubauen — Grundlage für Soft-Navigation zwischen
// Settings-Blättern.
function updateNavigationActiveState(navigation, activeLeaf) {
  if (!navigation) return;

  const collapsible = navigation.classList.contains('settings-shell__navigation--collapsible');
  const activeDomainId = activeLeaf?.domainId ?? null;

  for (const group of navigation.querySelectorAll('.settings-shell__navigation-group')) {
    const isActiveDomain = group.dataset.domainId === activeDomainId;
    group.classList.toggle('settings-shell__navigation-group--active', isActiveDomain);
    // Single-Open: die aktive Domäne wird aufgeklappt, alle anderen schließen
    // mit. Ohne aktives Blatt schliessen alle - sonst stand links die Domäne
    // des zuletzt besuchten Blatts offen, während rechts die Übersicht begann
    // (Critique 2026-07-27). Ein Navigationszustand, der dem Inhalt
    // widerspricht, kostet mehr Vertrauen als er Wege spart.
    if (collapsible) {
      setGroupExpanded(group, Boolean(activeDomainId) && isActiveDomain);
    }
  }

  for (const link of navigation.querySelectorAll('.settings-shell__navigation-link')) {
    const isActive = link.dataset.leafId === activeLeaf?.id;
    link.classList.toggle('settings-shell__navigation-link--active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
}

function createOverviewLink({ href, icon, title, description, entry }) {
  const link = createLink(href, 'settings-overview-link');
  // Eine Domaenen-Zeile hat kein Blatt und damit kein Modul: sie bekommt ihr
  // Zeichen ohne Marke, wie bisher.
  link.appendChild(entry
    ? createLeafMark(entry, 'settings-overview-link__icon')
    : createIcon(icon, 'settings-overview-link__icon'));

  const copy = document.createElement('span');
  copy.className = 'settings-overview-link__copy';

  const label = document.createElement('span');
  label.className = 'settings-overview-link__title';
  label.textContent = title;
  copy.appendChild(label);

  if (description) {
    const detail = document.createElement('span');
    detail.className = 'settings-overview-link__description';
    detail.textContent = description;
    copy.appendChild(detail);
  }

  link.append(
    copy,
    createIcon('chevron-right', 'settings-overview-link__chevron'),
  );
  return link;
}

function createOverviewHeader(title, description = null) {
  const header = document.createElement('header');
  header.className = 'settings-mobile-overview__header';

  const heading = document.createElement('h2');
  heading.className = 'settings-mobile-overview__title';
  heading.textContent = title;
  header.appendChild(heading);

  if (description) {
    const detail = document.createElement('p');
    detail.className = 'settings-mobile-overview__description';
    detail.textContent = description;
    header.appendChild(detail);
  }

  return header;
}

function createDesktopLeafLink(entry) {
  const link = createLink(entry.path, 'settings-desktop-overview__leaf');
  link.appendChild(createLeafMark(entry, 'settings-desktop-overview__leaf-icon'));

  const copy = document.createElement('span');
  copy.className = 'settings-desktop-overview__leaf-copy';

  const label = document.createElement('span');
  label.className = 'settings-desktop-overview__leaf-title';
  label.textContent = t(entry.labelKey);

  const description = document.createElement('span');
  description.className = 'settings-desktop-overview__leaf-description';
  description.textContent = t(entry.descriptionKey);

  copy.append(label, description);
  link.append(
    copy,
    createIcon('chevron-right', 'settings-desktop-overview__leaf-chevron'),
  );
  return link;
}

function renderDomainsOverview(content, domains, user) {
  const overview = document.createElement('section');
  overview.className = 'settings-mobile-overview settings-mobile-overview--domains';

  const description = document.createElement('p');
  description.className = 'settings-mobile-overview__description';
  description.textContent = t('settings.mobileOverviewDescription');
  overview.appendChild(description);

  const links = document.createElement('div');
  links.className = 'settings-mobile-overview__links';
  for (const domain of domains) {
    links.appendChild(createOverviewLink({
      href: settingsOverviewUrl(domain.id),
      icon: domain.icon,
      title: t(domain.labelKey),
    }));
  }

  overview.appendChild(links);

  const desktopOverview = document.createElement('section');
  desktopOverview.className = 'settings-desktop-overview';

  for (const domain of domains) {
    const leaves = allowedLeavesForDomain(domain.id, user);
    if (!leaves.length) continue;

    const domainSection = document.createElement('section');
    domainSection.className = 'settings-desktop-overview__domain';

    const heading = document.createElement('h2');
    heading.className = 'settings-desktop-overview__domain-title';
    heading.append(
      createIcon(domain.icon, 'settings-desktop-overview__domain-icon'),
      document.createTextNode(t(domain.labelKey)),
    );

    const leafList = document.createElement('div');
    leafList.className = 'settings-desktop-overview__leaf-list';
    for (const entry of leaves) {
      leafList.appendChild(createDesktopLeafLink(entry));
    }

    domainSection.append(heading, leafList);
    desktopOverview.appendChild(domainSection);
  }

  content.replaceChildren(overview, desktopOverview);
}

function renderDomainOverview(content, domain, user) {
  const overview = document.createElement('section');
  overview.className = 'settings-mobile-overview settings-domain-overview';
  overview.appendChild(createOverviewHeader(
    t('settings.mobileDomainTitle', { domain: t(domain.labelKey) }),
  ));

  const backLink = createLink(settingsOverviewUrl(), 'settings-overview-back-link');
  backLink.append(
    createIcon('arrow-left', 'settings-overview-back-link__icon'),
    document.createTextNode(t('settings.backToSettings')),
  );
  overview.appendChild(backLink);

  const links = document.createElement('div');
  links.className = 'settings-mobile-overview__links';
  for (const entry of allowedLeavesForDomain(domain.id, user)) {
    links.appendChild(createOverviewLink({
      href: entry.path,
      icon: entry.icon,
      title: t(entry.labelKey),
      description: t(entry.descriptionKey),
      entry,
    }));
  }

  overview.appendChild(links);
  content.replaceChildren(overview);
}

function createBreadcrumb(domain, leaf) {
  const breadcrumb = document.createElement('nav');
  breadcrumb.className = 'settings-breadcrumb';
  breadcrumb.setAttribute('aria-label', t('settings.breadcrumbLabel'));

  const list = document.createElement('ol');
  list.className = 'settings-breadcrumb__list';

  const settingsItem = document.createElement('li');
  settingsItem.className = 'settings-breadcrumb__item';
  const settingsLink = createLink(settingsOverviewUrl(), 'settings-breadcrumb__link');
  settingsLink.textContent = t('settings.title');
  settingsItem.appendChild(settingsLink);

  const domainItem = document.createElement('li');
  domainItem.className = 'settings-breadcrumb__item';
  const domainLink = createLink(
    settingsOverviewUrl(domain.id),
    'settings-breadcrumb__link',
  );
  domainLink.textContent = t(domain.labelKey);
  domainItem.appendChild(domainLink);

  const currentItem = document.createElement('li');
  currentItem.className = 'settings-breadcrumb__item settings-breadcrumb__item--current';
  currentItem.textContent = t(leaf.labelKey);
  currentItem.setAttribute('aria-current', 'page');

  for (const item of [settingsItem, domainItem, currentItem]) {
    if (list.childElementCount) {
      const separator = document.createElement('li');
      separator.className = 'settings-breadcrumb__separator';
      separator.textContent = '/';
      separator.setAttribute('aria-hidden', 'true');
      list.appendChild(separator);
    }
    list.appendChild(item);
  }

  breadcrumb.appendChild(list);
  return breadcrumb;
}

function createLeafHeader(leaf) {
  const header = document.createElement('header');
  header.className = 'settings-leaf-header';

  const heading = document.createElement('h1');
  heading.className = 'settings-leaf-header__title';
  heading.textContent = t(leaf.labelKey);

  header.appendChild(heading);
  if (!leaf.descriptionInContent) {
    const description = document.createElement('p');
    description.className = 'settings-leaf-header__description';
    description.textContent = t(leaf.descriptionKey);
    header.appendChild(description);
  }
  return header;
}

async function renderLeafContent(content, leaf, domain, user, query) {
  const breadcrumb = createBreadcrumb(domain, leaf);
  // Nach dem Ziel benannt, nicht nach der Wurzel: der Link führt auf die
  // Domänen-Übersicht, hiess aber "Zurück zu Einstellungen" - genau wie der
  // Link eine Ebene höher, der woanders hinführt (Critique 2026-07-27).
  // Mobil ist das die einzige Rückwärts-Affordance.
  const backLink = createLink(
    settingsOverviewUrl(domain.id),
    'settings-leaf-back-link',
  );
  backLink.append(
    createIcon('arrow-left', 'settings-leaf-back-link__icon'),
    document.createTextNode(t('settings.backToDomain', { domain: t(domain.labelKey) })),
  );

  // Der Leaf-Header wird zentral aus der Registry gerendert (Prio 5/B1): die
  // Blätter liefern nur noch Content. Der Header liegt als Geschwister *über*
  // dem Content-Container, damit Leaf-interne Re-Renders (die `leafContainer`
  // per replaceChildren leeren) ihn nicht entfernen.
  const header = createLeafHeader(leaf);
  const heading = header.querySelector('.settings-leaf-header__title');

  const leafContainer = document.createElement('div');
  leafContainer.className = 'settings-leaf';
  content.replaceChildren(breadcrumb, backLink, header, leafContainer);

  const loadAndRender = async ({ focusRetry = false } = {}) => {
    leafContainer.replaceChildren();
    // Der Blattwechsel laedt ein Modul und danach dessen Daten. Bis dahin stand
    // hier ein leerer Kasten (Critique 2026-07-27). aria-busy gilt sofort; das
    // Skelett kommt erst nach einer kurzen Frist, damit ein Blatt aus dem
    // Modul-Cache nicht kurz aufblitzt.
    leafContainer.setAttribute('aria-busy', 'true');
    const skeletonTimer = setTimeout(() => {
      if (leafContainer.isConnected && !leafContainer.firstChild) {
        leafContainer.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 3, lines: 3 }));
      }
    }, SKELETON_DELAY_MS);

    try {
      const module = await leaf.loader();
      if (typeof module.render !== 'function') throw new TypeError('Settings leaf must export render()');
      clearTimeout(skeletonTimer);
      leafContainer.replaceChildren();
      await module.render(leafContainer, { user, query });
      leafContainer.removeAttribute('aria-busy');
      watchLeafForms(leafContainer);

      heading.tabIndex = -1;
      requestAnimationFrame(() => {
        heading.focus({ preventScroll: true });
      });
      hydrateIcons(content);
    } catch (error) {
      console.error(`[Settings] Failed to render ${leaf.id}:`, error);
      clearTimeout(skeletonTimer);
      leafContainer.removeAttribute('aria-busy');
      clearLeafEdits();
      const retryState = createRetryState({
        message: t('settings.loadError'),
        onRetry: () => loadAndRender({ focusRetry: true }),
      });
      leafContainer.replaceChildren(retryState);
      hydrateIcons(content);

      if (focusRetry) {
        const retryButton = retryState.querySelector('.settings-retry-state__button');
        requestAnimationFrame(() => {
          if (retryButton?.isConnected && leafContainer.contains(retryButton)) {
            retryButton.focus({ preventScroll: true });
          }
        });
      }
    }
  };

  await loadAndRender();
}

export async function renderSettingsShell(container, {
  user,
  leaf = null,
  view = null,
  domainId = null,
  query = new URLSearchParams(),
  incremental = false,
}) {
  const domains = filterSettingsDomains(user);
  const activeLeaf = leaf?.path ? findSettingsLeaf(leaf.path, user) : null;

  // Inkrementell: Wenn bereits eine Shell montiert ist, bleiben Seitenkopf und
  // Sidebar stehen — wir tauschen nur den Aktivzustand und den Detailbereich.
  const existingShell = incremental ? container.querySelector('.settings-shell') : null;
  let shell;
  let content;

  if (existingShell) {
    shell = existingShell;
    content = shell.querySelector('.settings-shell__content');
    updateNavigationActiveState(
      shell.querySelector('.settings-shell__navigation'),
      activeLeaf,
    );
  } else {
    // Frische Shell: der geteilte Preferences-Cache gilt genau für einen
    // Settings-Besuch. Alles, was zwischenzeitlich ausserhalb geschrieben
    // wurde (z. B. die Widget-Konfiguration im Dashboard), ist damit weg.
    resetPreferencesCache();

    const page = document.createElement('div');
    page.className = 'page settings-page';

    const pageHeader = document.createElement('header');
    pageHeader.className = 'page__header settings-shell-header';
    const pageTitle = document.createElement('h1');
    // Nicht `page__title` (22/28px): jedes andere Modul rendert seinen
    // Seitentitel mit 20px, und der Settings-Leaf-Titel tut es auch. Zwei
    // h1-Größen für dieselbe Ebene (Critique 2026-07-27).
    pageTitle.className = 'settings-shell-header__title';
    pageTitle.textContent = t('settings.title');
    pageHeader.appendChild(pageTitle);

    shell = document.createElement('div');
    shell.className = 'settings-shell';
    const navigation = createNavigation(domains, user, activeLeaf);
    content = document.createElement('div');
    content.className = 'settings-shell__content';
    shell.append(navigation, content);
    page.append(pageHeader, shell);
    container.replaceChildren(page);
    // Sidebar-Icons einmalig bei der Montage hydrieren; die Detail-Icons werden
    // pro Render separat (nur im Content-Bereich) hydriert.
    hydrateIcons(navigation);
  }

  const page = shell.closest('.settings-page');
  page?.classList.toggle('settings-page--leaf', Boolean(activeLeaf));

  if (activeLeaf) {
    const domain = domains.find((entry) => entry.id === activeLeaf.domainId);
    if (!domain) {
      console.error(
        `[Settings] Cannot render ${activeLeaf.id}: domain "${activeLeaf.domainId}" is not available.`,
      );
      renderDomainsOverview(content, domains, user);
      hydrateIcons(content);
    } else {
      await renderLeafContent(content, activeLeaf, domain, user, query);
    }
  } else {
    const domain = view === 'domain'
      ? domains.find((entry) => entry.id === domainId)
      : null;
    if (domain) {
      renderDomainOverview(content, domain, user);
    } else {
      renderDomainsOverview(content, domains, user);
    }
    hydrateIcons(content);
  }
}
