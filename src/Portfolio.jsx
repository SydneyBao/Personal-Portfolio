import React, { useState, useEffect } from 'react';
import Modal from 'react-modal';

const images = [
  { url: '/portfolio/HeadshotNews.gif', title: 'Headshot News' },
  { url: '/portfolio/NutritionalPalThumbnail.gif', title: 'Nutritional Pal' },
];

function Portfolio() {
  const [selectedImage, setSelectedImage] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  const handleImageClick = (index) => {
    setSelectedImage(images[index]);
    setCurrentIndex(index);
  };

  const closeModal = () => {
    setSelectedImage(null);
  };

  const goToPrevious = () => {
    const newIndex = (currentIndex - 1 + images.length) % images.length;
    setSelectedImage(images[newIndex]);
    setCurrentIndex(newIndex);
  };

  const goToNext = () => {
    const newIndex = (currentIndex + 1) % images.length;
    setSelectedImage(images[newIndex]);
    setCurrentIndex(newIndex);
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'ArrowLeft') {
        goToPrevious();
      } else if (event.key === 'ArrowRight') {
        goToNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentIndex]);

  const customStyles = {
    content: {
      top: '50%',
      left: '50%',
      right: 'auto',
      bottom: 'auto',
      marginRight: '-50%',
      transform: 'translate(-50%, -50%)',
      backgroundColor: 'transparent',
      border: 'none',
      padding: '0',
     
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    },
    overlay: {
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
    }
  };

  return (
    <div id="portfolio">
      <div className="container-fluid p-0">
        <div className="row g-0">
          {images.map((image, index) => (
            <div className="col-lg-6" key={index}>
              <div className="portfolio-box" onClick={() => handleImageClick(index)}>
                <img className="img-fluid" src={image.url} alt={image.title} />
                <div className="portfolio-box-caption">
                  <div className="project-category text-white-50">
                    {index === 0 ? 'React, Puppeteer, Firebase' : 'Python, RAG, AI-Bloks'}
                  </div>
                  <div className="project-name">{image.title}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Modal
        isOpen={!!selectedImage}
        onRequestClose={closeModal}
        style={customStyles}
        contentLabel="Image Modal"
      >
        {selectedImage && (
          <div className="modal-content" style={{ color: 'white', textAlign: 'center', position: 'relative', width: '90%' }}>
            <img 
              src={selectedImage.url} 
              alt={selectedImage.title} 
              style={{ 
                width: '100%', 
                height: 'auto', 
                maxHeight: '80vh',
                objectFit: 'contain' 
              }} 
            />
            {currentIndex === 0 ? (
              <h2 style={{ margin: 15}}>
                <a href="https://headshotnews.com" target="_blank" rel="noopener noreferrer" style={{ color: 'white', textDecoration: 'none'}}>
                  {selectedImage.title}
                </a>
              </h2>
            ) : (
              <h2 style={{margin: 15}}>{selectedImage.title}</h2>
            )}
          </div>
        )}
        <button onClick={goToPrevious} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'white', fontSize: '2rem', cursor: 'pointer' }}>&#9664;</button>
        <button onClick={goToNext} style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'white', fontSize: '2rem', cursor: 'pointer' }}>&#9654;</button>
      </Modal>
    </div>
  );
}

export default Portfolio;