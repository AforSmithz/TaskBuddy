"use client";

import { motion } from "motion/react";

/**
 * Client-only hover-lift shell. Kept separate from <StatTile> so the tile
 * itself stays a server component (and can receive Lucide icon props).
 */
export function MotionTile({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
