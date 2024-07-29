// src/Navbar.js
import React from 'react';
import { Navbar, Nav, Container } from 'react-bootstrap';
import './custom.scss';

function NavigationBar() {
    return (
      <Navbar expand="lg" fixed="top" className="nav py-2" id="mainNav">
        <Container className="px-3 px-lg-3 py-1">
          <Navbar.Brand href="#page-top">Sydney Bao</Navbar.Brand>
          <Navbar.Toggle aria-controls="navbarResponsive" />
          <Navbar.Collapse id="navbarResponsive">
            <Nav className="ms-auto my-2 my-lg-0">
              <Nav.Link href="#portfolio">Portfolio</Nav.Link>
            </Nav>
          </Navbar.Collapse>
        </Container>
      </Navbar>
    );
  }

export default NavigationBar;