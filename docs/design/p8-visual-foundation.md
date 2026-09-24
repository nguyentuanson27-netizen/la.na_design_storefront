# P8: Storefront Visual Foundation

## Architecture & Visual System

This document outlines the minimal, editorial menswear visual system foundation for LA Clothing.

### 1. Design Tokens & Palette

- `--ink: #11110f`: Deep charcoal / near-black for primary text, borders, and solid interactive buttons.
- `--paper: #f5f2ea`: Editorial warm off-white canvas backdrop.
- `--white: #fbfaf6`: Pure warm white for visual card elevations and input fields.
- `--stone: #d9d3c7`: Muted secondary stone for secondary buttons and neutral badges.
- `--olive: #60634e`: Earthy editorial green tone for accents and active state indicators.
- `--line: rgba(17, 17, 15, 0.2)`: 1px geometric borders maintaining architectural precision.

### 2. Typography Hierarchy

- **Display (`font-display`)**: Josefin Sans for headlines, product names, category labels, navigation, prices and button labels (owner amendment 2026-09-24; previously an editorial serif).
- **Body (`font-sans`)**: Mulish for descriptions, metadata, small print and forms (previously Arial).
- **Eyebrow Header (`.eyebrow`)**: Uppercase kicker navigation breadcrumbs (`0.68rem`, tracking `0.18em`).

### 3. Interactive Component Primitives

- **Buttons**:
  - `.btn--primary`: Solid ink button with white text and clean hover opacity.
  - `.btn--secondary`: Stone background for secondary actions.
  - `.btn--outline`: Transparent with 1px ink border.
  - `.btn:disabled`: Muted with `opacity: 0.45` and `pointer-events: none`.
- **Badges**:
  - `.badge--olive`: Earthy accent tag.
  - `.badge--stone`: Neutral product tag.
  - `.badge--outline`: Border-only minimal badge.
- **Skeletons & Shimmer**:
  - `.skeleton`: Multi-stop warm gradient shimmer animation for loading placeholders.
- **Empty States**:
  - `.empty-state` / `[data-ui-state="empty"]`: Centered layout with editorial title and bounded description.

### 4. Accessibility & Responsive Shell

- **Focus Rings (`:focus-visible`)**: 2px solid outline with 4px offset on all interactive links, buttons, and summary elements.
- **Skip Link (`.skip-link`)**: Positioned fixed at top-left, offscreen until focused via keyboard Tab navigation, directly targeting `#main-content`.
- **Responsive Navigation**:
  - Desktop: Expanded navigation grid (`1fr auto 1fr`) with primary nav links and utility links (Search, Account, Bag).
  - Mobile: Closed menu content set to `display: none` to prevent offscreen layout box horizontal overflow; expands to `display: grid` when opened.

### 5. Verification Evidence

- `tests/integrations/homepage-links.test.ts`: Guards all header and footer links ensuring they resolve to real App Router pages.
- `tests/a11y-runtime/editorial.spec.ts`:
  - Desktop 1440x900 viewport visual shell (0 horizontal overflow, 0 Axe violations).
  - Mobile 390x844 responsive navigation menu toggle (0 horizontal overflow, 0 Axe violations).
  - Keyboard Tab navigation across editorial pages.
