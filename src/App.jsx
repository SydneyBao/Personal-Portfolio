import React, { useEffect, useRef } from 'react';
import NET from 'vanta/dist/vanta.net.min';
import * as THREE from 'three';

import './App.css';
import './custom.scss';
import NavigationBar from './Navbar';
import Portfolio from './Portfolio';
import Home from './Home';
import Footer from './Footer';

function App() {
  const vantaRef = useRef(null);
  const vantaEffectRef = useRef(null);

  useEffect(() => {
    let vantaEffect;

    if (vantaRef.current) {
      vantaEffectRef.current = NET({
        el: vantaRef.current,
        THREE: THREE,
        mouseControls: true,
        touchControls: true,
        gyroControls: false,
        minHeight: 200.00,
        minWidth: 200.00,
        scale: 1.00,
        scaleMobile: 1.00,
        color: 0x4bd1ed,
        backgroundColor: 0x141e1e,
        points: 10.00,
        maxDistance: 23.00,
        spacing: 15.00
      });

      const scene = vantaEffectRef.current.scene;
      
      scene.traverse((object) => {
        if (object instanceof THREE.LineSegments) {
          object.material.color.setHex(0x251b39); 
        }
      });
    }
    
    return () => {
      if (vantaEffect) vantaEffect.destroy();
    };
  }, []);

  return (
    <div className="app">
      <div className="bg" id="vanta" ref={vantaRef}>
        <NavigationBar />
        <div className="content">
          <section className="home-section">
            <Home />
          </section>
          <section className="portfolio-section">
            <Portfolio />
          </section>
          <section className="footer-section">
            <Footer />
          </section>
        </div>
      </div>
    </div>
  );
}

export default App;