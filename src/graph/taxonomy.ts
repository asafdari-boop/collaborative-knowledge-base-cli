export interface DomainDefinition {
  slug: string;
  title: string;
  description: string;
}

export interface MocDefinition {
  slug: string;
  title: string;
  domainSlug: string;
  description: string;
  aliases: string[];
}

export interface Taxonomy {
  version: number;
  domains: DomainDefinition[];
  mocs: MocDefinition[];
}

function domain(slug: string, title: string, description: string): DomainDefinition {
  return { slug, title, description };
}

function moc(
  slug: string,
  title: string,
  domainSlug: string,
  description: string,
  aliases: string[] = [],
): MocDefinition {
  return { slug, title, domainSlug, description, aliases };
}

export const DEFAULT_TAXONOMY: Taxonomy = {
  version: 1,
  domains: [
    domain("thinking-and-frameworks", "Thinking and Frameworks", "Models for understanding, deciding, and acting."),
    domain("goals-and-values", "Goals and Values", "Purposes, principles, identity, and deliberate personal direction."),
    domain("health-and-fitness", "Health and Fitness", "Physical and mental health, performance, recovery, and longevity."),
    domain("writing-and-learning", "Writing and Learning", "Writing craft, content creation, books, and learning systems."),
    domain("business-and-money", "Business and Money", "Investing, finance, company building, and institutions."),
    domain("technology", "Technology", "Artificial intelligence and other consequential technologies."),
    domain("people-and-community", "People and Community", "People, events, communities, and networks."),
    domain("taste", "Taste", "Curated favorites, culture, humor, products, places, and experiences."),
  ],
  mocs: [
    moc("frameworks-and-mental-models", "Frameworks & Mental Models", "thinking-and-frameworks", "Reusable ways to reason about the world."),
    moc("decision-making-and-life-formulas", "Decision-Making & Life Formulas", "thinking-and-frameworks", "Decision tools, equations, and operating heuristics.", ["Decision equations"]),
    moc("psychology-and-human-behavior", "Psychology & Human Behavior", "thinking-and-frameworks", "Human motives, perception, and behavior."),
    moc("power-and-strategy", "Power & Strategy", "thinking-and-frameworks", "Power, leverage, positioning, and strategic action.", ["Power principles"]),
    moc("values-morals-and-principles", "Values, Morals & Principles", "goals-and-values", "The principles used to choose and judge action.", ["Personal principles"]),
    moc("goals-and-life-purpose", "Goals & Life Purpose", "goals-and-values", "Long-horizon aims, purpose, and direction."),
    moc("high-agency-and-personal-development", "High Agency & Personal Development", "goals-and-values", "Self-directed growth, execution, and character.", ["Agency"]),
    moc("health-and-medicine", "Health & Medicine", "health-and-fitness", "Health conditions, medicine, care, and clinical knowledge."),
    moc("fitness-and-training", "Fitness & Training", "health-and-fitness", "Training methods, movement, and performance."),
    moc("nutrition-and-metabolism", "Nutrition & Metabolism", "health-and-fitness", "Food, energy balance, and metabolic health."),
    moc("longevity-and-recovery", "Longevity & Recovery", "health-and-fitness", "Sleep, recovery, prevention, and healthy lifespan."),
    moc("writing-and-storytelling", "Writing & Storytelling", "writing-and-learning", "Writing craft, voice, narrative, and persuasion."),
    moc("content-creation", "Content Creation", "writing-and-learning", "Creating, packaging, and distributing useful media."),
    moc("books-and-learning", "Books & Learning", "writing-and-learning", "Books, curricula, study, and learning systems."),
    moc("investments", "Investments", "business-and-money", "Investment theses, companies, assets, and decision records."),
    moc("taxes-and-personal-finance", "Taxes & Personal Finance", "business-and-money", "Taxes, cash management, and household finance."),
    moc("startups-and-company-building", "Startups & Company Building", "business-and-money", "Startup ideas, operating lessons, and company formation."),
    moc("companies-and-institutions", "Companies & Institutions", "business-and-money", "Organizations worth understanding, including incorruptible institutions."),
    moc("ai-and-technology", "AI & Technology", "technology", "Artificial intelligence, software, and emerging technology."),
    moc("people-and-thinkers", "People & Thinkers", "people-and-community", "People whose ideas, work, or relationships matter.", ["Influential People", "Example Thinker"]),
    moc("events-and-conferences", "Events & Conferences", "people-and-community", "Events attended, sessions, and conference knowledge."),
    moc("communities-and-networks", "Communities & Networks", "people-and-community", "Communities, ecosystems, and recurring networks."),
    moc("best-of-lists", "Best-of Lists", "taste", "Deliberately curated best examples across categories."),
    moc("film-television-and-anime", "Film, Television & Anime", "taste", "Screen stories and visual culture."),
    moc("music-and-podcasts", "Music & Podcasts", "taste", "Music, audio, and recurring listening."),
    moc("products-places-and-experiences", "Products, Places & Experiences", "taste", "Objects, destinations, and experiences worth remembering."),
    moc("humor-memes-and-quotes", "Humor, Memes & Quotes", "taste", "Humor, memorable lines, and cultural fragments.", ["Favorite Quotations", "Jokes and Memes"]),
  ],
};

export function renderTaxonomyMarkdown(taxonomy: Taxonomy): string {
  const lines = [
    "# Knowledge Taxonomy",
    "",
    "> This file is the human-readable authority for the graph hierarchy. Edit names, descriptions, aliases, or ordering here; CKB validates changes before publishing them.",
    "",
  ];
  for (const domainDefinition of taxonomy.domains) {
    lines.push(`## ${domainDefinition.title}`, "", domainDefinition.description, "");
    for (const child of taxonomy.mocs.filter((candidate) => candidate.domainSlug === domainDefinition.slug)) {
      lines.push(`- ${child.title}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
