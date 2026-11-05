fn main() {
    let words = ["Rust", "in", "a", "Linux", "VM", "in", "your", "browser", "tab"];
    let longest = words.iter().max_by_key(|w| w.len()).unwrap();
    println!("Hello from {}! Longest word: {longest} ({} letters)", words[0], longest.len());
}
