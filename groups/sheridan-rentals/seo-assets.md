# SEO Assets — Sheridan Rentals

## Website
- **Domain**: sheridantrailerrentals.us
- **Google Business Profile**: Sheridan Trailer Rentals (Tomball, TX)

## Latest Audit
> Run `seo-audit.ts audit --url "https://sheridantrailerrentals.us"` to update.

| Metric | Score | Last Checked |
|--------|-------|-------------|
| Overall SEO Score | — | Not yet audited |
| PageSpeed (Mobile) | — | — |
| PageSpeed (Desktop) | — | — |
| Schema Markup | — | — |

## Target Keywords & Rankings

> Run `seo-audit.ts keywords` monthly to update positions.

### Primary Keywords (High Intent)
| Keyword | Monthly Vol | Position | Last Checked |
|---------|------------|----------|-------------|
| trailer rental tomball tx | ~100 | — | — |
| rv rental houston | ~1,500 | — | — |
| car hauler rental houston | ~200 | — | — |
| landscaping trailer rental houston | ~100 | — | — |
| trailer rental near me | ~5,000 | — | — |

### RV-Specific
| Keyword | Monthly Vol | Position | Last Checked |
|---------|------------|----------|-------------|
| camper rental houston | ~500 | — | — |
| rv rental tomball tx | ~50 | — | — |
| rv rental near me | ~8,000 | — | — |
| rv rental with delivery houston | ~50 | — | — |

### Hauler/Utility
| Keyword | Monthly Vol | Position | Last Checked |
|---------|------------|----------|-------------|
| car hauler rental near me | ~2,000 | — | — |
| car hauler trailer rental | ~500 | — | — |
| utility trailer rental tomball | ~50 | — | — |
| moving trailer rental houston | ~200 | — | — |

## Schema Markup Requirements

### LocalBusiness + RentalService
```json
{
  "@context": "https://schema.org",
  "@type": ["LocalBusiness", "RentalAgency"],
  "name": "Sheridan Trailer Rentals",
  "url": "https://sheridantrailerrentals.us",
  "telephone": "",
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "Tomball",
    "addressRegion": "TX",
    "addressCountry": "US"
  },
  "areaServed": ["Tomball", "Houston", "Spring", "Magnolia", "Conroe"],
  "description": "Trailer and RV rentals in Tomball, TX. Car haulers, landscaping trailers, and RV campers. Delivery available.",
  "makesOffer": [
    { "@type": "Offer", "itemOffered": { "@type": "Product", "name": "RV Camper Rental", "description": "36ft RV camper, $150/night" }},
    { "@type": "Offer", "itemOffered": { "@type": "Product", "name": "Car Hauler Rental", "description": "Car hauler trailer, $65/day" }},
    { "@type": "Offer", "itemOffered": { "@type": "Product", "name": "Landscaping Trailer Rental", "description": "Landscaping trailer, $50/day" }}
  ]
}
```

## Meta Description Templates

- **Homepage**: "Trailer & RV rentals in Tomball, TX. Car haulers $65/day, landscaping trailers $50/day, RV camper $150/night. Delivery available. Book online today."
- **RV page**: "Rent a 36ft RV camper in Tomball, TX. $150/night, generator available. Delivery within 60 miles. Book at Sheridan Trailer Rentals."
- **Car Hauler page**: "Car hauler trailer rental in Tomball/Houston. $65/day, includes straps, ramps & winch. Book online at Sheridan Trailer Rentals."

## GBP Settings

- **Primary Category**: Trailer rental service
- **Secondary Categories**: RV rental agency, Equipment rental agency
- **Service Area**: 60 mile radius from Tomball, TX
- **Attributes**: Online booking, Delivery available
