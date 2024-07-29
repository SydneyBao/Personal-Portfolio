import { split } from "postcss/lib/list";

function splitString(input) {
    const characters = [];
    const regex=/[\s\S]/gu;

    let match;
    while ((match = regex.exec(input)) != null) {
        characters.push(match[0])
    }
    return characters;
}
export default splitString;