import React from 'react';
import { Container, Row, Col } from 'react-bootstrap';

const Footer = () => {
  return (
    <footer className="bg-light py-5">
      <Container>
        <Row className="justify-content-center">
          <Col lg={8}>
            <div className="d-flex justify-content-center">
              <div className="contact-item mx-3">
                <a href="mailto:someone@example.com" target="_blank" rel="noopener noreferrer">
                  <i className="bi bi-envelope fs-2 mb-2 text-muted"></i>
                </a>                    
              </div>
              <div className="contact-item mx-3">
                <a href="https://linkedin.com/in/sydney-bao" target="_blank" rel="noopener noreferrer">
                  <i className="bi bi-linkedin fs-2 mb-2 text-muted"></i>
                </a>  
              </div>
              <div className="contact-item mx-3">
                <a href="https://github.com/SydneyBao" target="_blank" rel="noopener noreferrer">
                  <i className="bi bi-github fs-2 mb-2 text-muted"></i>
                </a>  
              </div>
              <div className="contact-item mx-3">
                <a href="/SydneyBaoResume.pdf" target="_blank" rel="noopener noreferrer">
                  <i className="bi bi-file-earmark-person fs-2 mb-2 text-muted"></i>
                </a>  
              </div>
            </div>
          </Col>
        </Row>
        <Row className="mt-3">
          <Col xs={12}>
            <div className="small text-center text-muted">&copy; 2024 Sydney Bao</div>
          </Col>
        </Row>
      </Container>
    </footer>
  );
};

export default Footer;