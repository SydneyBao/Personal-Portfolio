export const projects = [
  {
    slug: 'popper-social',
    title: 'Popper.Social',
    eyebrow: 'Mobile · Social commerce',
    role: 'Mobile Engineer Intern · 2024',
    caption:
      'Redesigned event and market flows for a social events and local-deals app, then shipped account deletion, deals, and faster TestFlight feedback loops.',
    thumbnail: '/portfolio/posters/popper-social.webp',
    media: '/portfolio/Popper.gif',
    mediaItems: [
      {
        url: '/portfolio/posters/popper-social.webp',
        alt: 'Popper project cover featuring the mobile social experience',
        type: 'image',
      },
      {
        url: '/portfolio/Popper.gif',
        alt: 'Popper mobile app screens showing events and local deals',
        type: 'image',
      },
    ],
    alt: 'Popper mobile app screens showing events and local deals',
    categories: ['mobile'],
    tech: ['React Native', 'Firebase', 'Xcode', 'TestFlight', 'CI/CD'],
    highlights: ['500+ users', '20+ businesses', '30% active-user lift'],
    links: [],
    accent: '#c95187',
  },
  {
    slug: 'sydney-ai-assistant',
    title: "Sydney's AI Assistant",
    eyebrow: 'AI · Conversational portfolio',
    role: 'Personal project',
    caption:
      "A Gemini-powered chatbot that answers questions about Sydney's experience, projects, ideal work environment, and interests.",
    thumbnail: '/portfolio/posters/sydney-ai-assistant.webp',
    media: '/portfolio/chatbot.gif',
    mediaItems: [
      {
        url: '/portfolio/posters/sydney-ai-assistant.webp',
        alt: "Sydney's AI assistant project cover",
        type: 'image',
      },
      {
        url: '/portfolio/chatbot.gif',
        alt: "Sydney's AI assistant chat interface with suggested prompts",
        type: 'image',
      },
    ],
    alt: "Sydney's AI assistant chat interface with suggested prompts",
    categories: ['ai', 'web'],
    tech: ['Gemini API', 'React', 'Next.js', 'Vercel', 'CI/CD'],
    highlights: ['Guided prompts', 'Free-form chat', 'Live deployment'],
    links: [
      {
        label: 'Visit live project',
        url: 'https://gemini-chatbot-iota-five.vercel.app/',
      },
    ],
    accent: '#7459d9',
  },
  {
    slug: 'inventory-management',
    title: 'Inventory Management',
    eyebrow: 'Full-stack · Productivity',
    role: 'Personal project',
    caption:
      'A Firebase-backed inventory dashboard for searching items, tracking expiration dates and notes, and adding or removing entries.',
    thumbnail: '/portfolio/posters/inventory-management.webp',
    media: '/portfolio/InventoryManagement.gif',
    mediaItems: [
      {
        url: '/portfolio/posters/inventory-management.webp',
        alt: 'Inventory Management project cover',
        type: 'image',
      },
      {
        url: '/portfolio/InventoryManagement.gif',
        alt: 'Inventory dashboard showing searchable item cards and controls',
        type: 'image',
      },
    ],
    alt: 'Inventory dashboard showing searchable item cards and controls',
    categories: ['web'],
    tech: ['Next.js', 'Firebase', 'Material UI', 'Vercel', 'CI/CD'],
    highlights: ['Searchable inventory', 'Expiration tracking', 'Add and remove flows'],
    links: [
      {
        label: 'Visit live project',
        url: 'https://inventory-management-seven-tau.vercel.app/',
      },
    ],
    accent: '#238c85',
  },
  {
    slug: 'nutritional-pal',
    title: 'Nutritional Pal',
    eyebrow: 'AI/ML · Desktop assistant',
    role: 'Personal project · 2024',
    caption:
      'A voice-enabled nutrition assistant combining retrieval-augmented generation, open-source language models, and speech input and output.',
    thumbnail: '/portfolio/posters/nutritional-pal.webp',
    media: '/portfolio/NutritionalPal.gif',
    mediaItems: [
      {
        url: '/portfolio/posters/nutritional-pal.webp',
        alt: 'Nutritional Pal project cover',
        type: 'image',
      },
      {
        url: '/portfolio/NutritionalPal.gif',
        alt: 'Nutritional Pal desktop interface answering a nutrition question',
        type: 'image',
      },
    ],
    alt: 'Nutritional Pal desktop interface answering a nutrition question',
    categories: ['ai'],
    tech: ['Python', 'RAG', 'AI-Bloks', 'Tkinter', 'pyttsx3'],
    highlights: ['3 models evaluated', 'Voice input and output', '50% accuracy lift'],
    links: [
      {
        label: 'View source code',
        url: 'https://github.com/SydneyBao/AI-NutritionalPal',
      },
    ],
    accent: '#e07b4f',
  },
  {
    slug: 'headshot-news',
    title: 'Headshot News',
    eyebrow: 'Full-stack · Esports news',
    role: 'Group project · 2024',
    caption:
      "A full-stack esports news aggregator that scrapes five sources and refreshes its Firebase article feed daily. The team placed third in Northeastern's Startup Challenge.",
    thumbnail: '/portfolio/posters/headshot-news.webp',
    media: '/portfolio/HeadshotNews.gif',
    mediaItems: [
      {
        url: '/portfolio/posters/headshot-news.webp',
        alt: 'Headshot News project cover',
        type: 'image',
      },
      {
        url: '/portfolio/HeadshotNews.gif',
        alt: 'Headshot News esports article feed with Counter-Strike stories',
        type: 'image',
      },
    ],
    alt: 'Headshot News esports article feed with Counter-Strike stories',
    categories: ['web'],
    tech: ['React', 'Node.js', 'Firebase', 'Puppeteer', 'Google Cloud'],
    highlights: ['5 news sources', 'Daily updates', '3rd place'],
    links: [
      { label: 'Visit live project', url: 'https://headshotnews.com/' },
      { label: 'View source code', url: 'https://github.com/SydneyBao/HeadshotNews' },
    ],
    accent: '#d84c55',
  },
];

export const profileFilters = [
  { id: 'all', label: 'All work', icon: 'grid' },
  { id: 'web', label: 'Full-stack', icon: 'code' },
  { id: 'ai', label: 'AI + ML', icon: 'sparkles' },
  { id: 'mobile', label: 'Mobile', icon: 'phone' },
];
