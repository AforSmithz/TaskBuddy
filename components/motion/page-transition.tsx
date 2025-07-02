"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * Wraps every route via app/template.tsx. Because templates remount on
 * navigation, this replays a quick fade-and-rise each time the route changes.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
