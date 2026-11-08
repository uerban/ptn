/** Temporarily disabled while guidance camera following is being corrected.
 * Set VITE_GUIDANCE_AUTO_FOLLOW=true at build time to opt in for testing.
 * Covers walking follow and rider camera tracking; step clicks still work.
 */
export const GUIDANCE_AUTO_FOLLOW_ENABLED =
  import.meta.env.VITE_GUIDANCE_AUTO_FOLLOW === "true";
