import './App.css';
import './custom.scss';
import splitString from './utils/splitString';
import { motion } from "framer-motion";


const heading = "Hi, I'm Sydney";
const text = "With 11 years of coding experience, I bring a unique blend of creativity, passion, and technical expertise to the table. I have a strong foundation in Java, Python, and JavaScript, gained through nine years of private coding lessons and extensive experience programming front-end, back-end, and full stack applications.";

function Home() {

  const headingChars = splitString(heading);
  const textChars = splitString(text);

  const charVariants = {
    hidden: { opacity: 0 },
    reveal: { opacity: 1 },
  };

  return (
    <>
    <div id="page-top">
        <motion.h1
            className='header'
            initial="hidden"
            whileInView="reveal"
            transition={{ staggerChildren: .07 }}
        >
            {headingChars.map((char, index) => (
            <motion.span
                key={index}
                transition={{ duration: 0.5 }}
                variants={charVariants}
            >
                {char}
            </motion.span>
            ))}
        </motion.h1>
        <motion.p
            className='paragraph text-white-75 mb-5'
            initial="hidden"
            whileInView="reveal"
            transition={{ staggerChildren: .015 }}
        >
            {textChars.map((char, index) => (
            <motion.span
                key={index}
                transition={{ duration: 0.5 }}
                variants={charVariants}
            >
                {char}
            </motion.span>
            ))}
        </motion.p>
        <div className="arrow"></div>
        <a className="btn" href="/SydneyBaoResume.pdf" target="_blank" rel="noopener noreferrer">Find Out More</a> 
    </div>
    
    </>
  );
}

export default Home;