"use client";

import { motion, useReducedMotion } from "motion/react";

/** Standard "ease-out-expo"-ish curve — calm, enterprise-grade settle. */
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Fade-and-rise a block into view on mount. Use for standalone sections.
 */
export function Reveal({
  children,
  delay = 0,
  y = 16,
  duration = 0.5,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  duration?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduce ? 0 : y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Container that cascades its <StaggerItem> children into view one by one.
 * Pass layout classes (grid/flex/divide-y) straight through `className`.
 */
export function Stagger({
  children,
  className,
  delay = 0,
  gap = 0.07,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  gap?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: {
          transition: {
            staggerChildren: reduce ? 0 : gap,
            delayChildren: delay,
          },
        },
      }}
    >
      {children}
    </motion.div>
  );
}

/** A single cascading child — must be rendered inside <Stagger>. */
export function StaggerItem({
  children,
  className,
  y = 16,
}: {
  children: React.ReactNode;
  className?: string;
  y?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: reduce ? 0 : y },
        show: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.5, ease: EASE },
        },
      }}
    >
      {children}
    </motion.div>
  );
}
