import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { useLenis } from '../context/LenisContext';

const NAV_LINKS = [
  { name: 'Method', href: '#method', id: 'method' },
  { name: 'Causes', href: '#causes', id: 'causes' },
  { name: 'Predictor', href: '#predictor', id: 'predictor' },
  { name: 'Data', href: '#data', id: 'data' },
];

export const Navbar: React.FC = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [activeSection, setActiveSection] = useState<string>('');
  const lastScrollY = useRef(0);
  const { scrollTo } = useLenis();

  useEffect(() => {
    const handleScroll = () => {
      const currentY = window.scrollY;
      setIsScrolled(currentY > 80);

      // Hide on scroll down, show on scroll up (after passing 120px)
      if (currentY > 120) {
        if (currentY > lastScrollY.current + 5 && !menuOpen) {
          setIsHidden(true);
        } else if (currentY < lastScrollY.current - 5) {
          setIsHidden(false);
        }
      } else {
        setIsHidden(false);
      }
      lastScrollY.current = currentY;

      // Determine active section based on scroll position
      const sections = ['method', 'causes', 'predictor', 'data'];
      let currentActive = '';
      for (const id of sections) {
        const el = document.getElementById(id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= window.innerHeight * 0.45 && rect.bottom >= window.innerHeight * 0.15) {
            currentActive = id;
            break;
          }
        }
      }
      setActiveSection(currentActive);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [menuOpen]);

  const handleLinkClick = (id: string) => {
    setMenuOpen(false);
    scrollTo(`#${id}`, { offset: 0, duration: 1.6 });
  };

  return (
    <>
      <motion.header
        initial={{ y: 0 }}
        animate={{ y: isHidden ? '-100%' : 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className={`fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 md:px-12 transition-all duration-400 select-none ${
          isScrolled
            ? 'bg-black/20 backdrop-blur-xl border-b border-white/[0.06] py-4'
            : 'bg-transparent py-6'
        }`}
      >
        {/* Brand wordmark on the left */}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            scrollTo(0, { offset: 0, duration: 1.6 });
          }}
          className="text-white uppercase tracking-[0.25em] md:tracking-[0.3em] font-light text-xs sm:text-sm whitespace-nowrap hover:opacity-90 transition-opacity"
        >
          Holding Pattern
        </a>

        {/* Desktop Links with hover underline and active dot layoutId */}
        <nav className="hidden md:flex items-center gap-10">
          {NAV_LINKS.map((link) => {
            const isActive = activeSection === link.id;
            return (
              <div key={link.name} className="relative py-1 flex flex-col items-center">
                <a
                  href={link.href}
                  onClick={(e) => {
                    e.preventDefault();
                    handleLinkClick(link.id);
                  }}
                  className="group relative text-white/80 uppercase tracking-[0.2em] text-xs font-light hover:text-white transition-colors duration-300 whitespace-nowrap py-0.5"
                >
                  {link.name}
                  {/* 1px hover underline growing from the left */}
                  <span className="absolute bottom-0 left-0 w-full h-[1px] bg-white scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-left pointer-events-none" />
                </a>

                {/* Active-section indicator: 4px dot animated between links */}
                {isActive && (
                  <motion.span
                    layoutId="activeNavDot"
                    transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                    className="absolute -bottom-2 w-1 h-1 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
                  />
                )}
              </div>
            );
          })}
        </nav>

        {/* Mobile Hamburger toggle */}
        <button
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden text-white/90 hover:text-white p-1 transition-colors cursor-pointer focus:outline-none"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </motion.header>

      {/* Mobile Menu Dropdown */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="mobile-menu-glass fixed top-20 left-4 right-4 z-50 rounded-2xl py-8 flex flex-col items-center justify-center gap-5 md:hidden"
          >
            {NAV_LINKS.map((link, index) => (
              <motion.a
                key={link.name}
                href={link.href}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{
                  duration: 0.3,
                  delay: 0.05 + index * 0.06,
                  ease: 'easeOut',
                }}
                onClick={(e) => {
                  e.preventDefault();
                  handleLinkClick(link.id);
                }}
                className="text-white/90 tracking-[0.25em] uppercase font-light text-sm hover:text-white transition-colors duration-300 py-1"
              >
                {link.name}
              </motion.a>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
